/**
 * Plan M3.2/M3.5: the Worker's content source, against a real local D1 in workerd.
 */
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { ContentUnavailableError, D1ContentSource } from "../../src/content/d1-source";
import { siteContentSchema, type Theme } from "../../src/content/schema";
import type { D1Database } from "../../src/db/types";
import { type ImageResolver, imagePathsOf, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-16T10:00:00Z");
const ctx = { now };
const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, theme });
const hashes = new Map<string, string>();
const images: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const ITEM = menu.categories[0].items[0].id;

beforeAll(async () => {
  for (const path of imagePathsOf(content as StoredContent)) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    hashes.set(path, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content as StoredContent, images)));
});

/** A D1 binding that fails every call while `outage.on` is set, as during an outage. */
function withOutage(real: D1Database) {
  const outage = { on: false };
  const fail = () => {
    if (outage.on) throw new Error("D1_ERROR: network connection lost");
  };
  const binding = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => (fail(), target.prepare(sql));
      if (prop === "batch") return (s: Parameters<D1Database["batch"]>[0]) => (fail(), target.batch(s));
      return Reflect.get(target, prop);
    },
  });
  return { binding, outage };
}

describe("D1ContentSource", () => {
  it("serves the site's content with its theme, validated", async () => {
    const loaded = await new D1ContentSource(db, "bistro", theme as Theme).load(ctx);
    expect(loaded.content.settings.name.sv).toBe("Bistro Norden");
    expect(loaded.content.theme).toEqual(theme);
    expect(loaded.stale).toBe(false);
    expect(loaded.content.menu).toEqual(content.menu);
  });

  it("shows a save on the very next request", async () => {
    const source = new D1ContentSource(db, "bistro", theme as Theme);
    const before = await source.load(ctx);
    await db.prepare("UPDATE menu_items SET price_ore = 9900 WHERE site_id = 'bistro' AND id = ?").bind(ITEM).run();
    const after = await source.load(ctx);
    expect(after.version).not.toBe(before.version);
    expect(after.content.menu.categories[0].items[0].price).toBe(9900);
  });

  it("re-reads only when the version moved", async () => {
    const source = new D1ContentSource(db, "bistro", theme as Theme);
    const spy = vi.spyOn(db, "batch");
    await source.load(ctx);
    await source.load(ctx);
    await source.load(ctx);
    expect(spy).toHaveBeenCalledTimes(1); // one export; the other loads only read the version
    spy.mockRestore();
  });

  it("reports sold-out dates for the request to judge against today", async () => {
    await db.prepare("UPDATE menu_items SET sold_out_on = '2026-10-16' WHERE site_id = 'bistro' AND id = ?").bind(ITEM).run();
    const loaded = await new D1ContentSource(db, "bistro", theme as Theme).load(ctx);
    expect(loaded.soldOutOn).toEqual({ [ITEM]: "2026-10-16" });
  });

  it("serves the last good copy, marked stale, when D1 fails", async () => {
    const { binding, outage } = withOutage(db);
    const source = new D1ContentSource(binding, "bistro", theme as Theme);
    const good = await source.load(ctx);
    outage.on = true;
    const during = await source.load(ctx);
    expect(during.stale).toBe(true);
    expect(during.content).toEqual(good.content);
  });

  it("throws ContentUnavailableError when D1 fails and nothing is held", async () => {
    const { binding, outage } = withOutage(db);
    outage.on = true;
    const source = new D1ContentSource(binding, "bistro", theme as Theme);
    await expect(source.load(ctx)).rejects.toThrow(ContentUnavailableError);
  });

  it("throws for a site with no content", async () => {
    await expect(new D1ContentSource(db, "nobody", theme as Theme).load(ctx)).rejects.toThrow(/no content/);
  });

  it("refuses content that fails the schema, instead of showing it", async () => {
    // Bypass the CHECKs' reach: a tag outside the vocabulary is left to the schema.
    await db.prepare(`UPDATE menu_items SET tags = '["halal"]' WHERE site_id = 'bistro' AND id = ?`).bind(ITEM).run();
    await expect(new D1ContentSource(db, "bistro", theme as Theme).load(ctx)).rejects.toThrow(/fails the schema/);
  });
});
