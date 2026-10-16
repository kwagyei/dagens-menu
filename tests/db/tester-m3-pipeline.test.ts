/**
 * Tester (2026-10-16, ADR-011 plan M3.2, M3.3, M3.5): the request pipeline end to end in
 * workerd — handlePage over a real D1ContentSource and local D1 — including the degraded
 * paths with a D1 binding that throws or hangs. Failing tests here are defects in the tester
 * report (~/Vault/Projects/dagens-menu/tester/2026-10-16-m3-workers.md).
 */
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { D1ContentSource } from "../../src/content/d1-source";
import { siteContentSchema, type SiteSettings, type Theme } from "../../src/content/schema";
import type { D1Database } from "../../src/db/types";
import { type ImageResolver, imagePathsOf, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { handlePage, type HandlerDeps, type PageState } from "../../src/server/handler";

const db = env.DB;
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

type Mode = "ok" | "throw" | "hang";
/** A D1 binding whose calls throw, or never settle, while `state.mode` says so. */
function faulty(real: D1Database) {
  const state = { mode: "ok" as Mode };
  const guard = <T>(run: () => Promise<T>): Promise<T> => {
    if (state.mode === "throw") return Promise.reject(new Error("D1_ERROR: network connection lost"));
    if (state.mode === "hang") return new Promise<T>(() => {});
    return run();
  };
  const binding = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => {
          const stmt = target.prepare(sql);
          const wrap = (s: typeof stmt): typeof stmt =>
            new Proxy(s, {
              get(t, p) {
                if (p === "bind") return (...args: unknown[]) => wrap((t.bind as (...a: unknown[]) => typeof stmt)(...args));
                if (p === "first" || p === "all" || p === "run" || p === "raw")
                  return (...args: unknown[]) => guard(() => (t[p] as (...a: unknown[]) => Promise<unknown>)(...args));
                return Reflect.get(t, p);
              },
            });
          return wrap(stmt);
        };
      if (prop === "batch") return (s: Parameters<D1Database["batch"]>[0]) => guard(() => target.batch(s));
      return Reflect.get(target, prop);
    },
  });
  return { binding, state };
}

function pipeline(binding: D1Database, now = new Date("2026-10-16T10:00:00Z")) {
  const source = new D1ContentSource(binding, "bistro", theme as Theme);
  const clock = { now };
  const deps: HandlerDeps = {
    runtimeSiteId: "bistro",
    buildSiteId: "bistro",
    buildId: "b1",
    source: () => source,
    emergencySettings: () => settings as SiteSettings,
    now: () => clock.now,
    log: () => {},
  };
  const render = vi.fn(async (s: PageState) => {
    const items = s.content.menu.categories.flatMap((c) => c.items);
    const body = items.map((i) => `${i.name.en} ${i.price} ${s.today.soldOut.includes(i.id) ? "SOLD-OUT" : ""}`).join("\n");
    return new Response(body, { headers: { "Content-Type": "text/html" } });
  });
  const get = (path = "/", headers: Record<string, string> = {}) =>
    handlePage(new Request(`https://bistro.workers.dev${path}`, { headers }), deps, render);
  return { get, render, clock };
}

describe("pipeline over real D1", () => {
  it("changes the ETag after a save and renders the new price; the old ETag no longer gets a 304", async () => {
    const { get } = pipeline(db);
    const first = await get("/menu/");
    const tag = first.headers.get("ETag")!;
    expect((await get("/menu/", { "If-None-Match": tag })).status).toBe(304);
    await db.prepare("UPDATE menu_items SET price_ore = 9900 WHERE site_id = 'bistro' AND id = ?").bind(ITEM).run();
    const after = await get("/menu/", { "If-None-Match": tag });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(tag);
    expect(await after.text()).toContain(" 9900 ");
  });

  it("shows a dish sold out today, and clears it at Stockholm midnight without a save", async () => {
    await db.prepare("UPDATE menu_items SET sold_out_on = '2026-10-16' WHERE site_id = 'bistro' AND id = ?").bind(ITEM).run();
    const { get, clock } = pipeline(db, new Date("2026-10-16T21:59:00Z"));
    const before = await get("/menu/");
    expect(await before.text()).toContain("SOLD-OUT");
    clock.now = new Date("2026-10-16T22:00:00Z");
    const after = await get("/menu/", { "If-None-Match": before.headers.get("ETag")! });
    expect(after.status).toBe(200);
    expect(await after.text()).not.toContain("SOLD-OUT");
  });
});

describe("degraded paths with a D1 binding that throws or hangs", () => {
  it("serves the 503 emergency page with no prices on a cold isolate when D1 throws", async () => {
    const { binding, state } = faulty(db);
    state.mode = "throw";
    const { get, render } = pipeline(binding);
    const res = await get("/menu/");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(render).not.toHaveBeenCalled();
    const html = await res.text();
    expect(html).not.toMatch(/\d\s*kr\b/);
    for (const c of menu.categories) for (const i of c.items) expect(html).not.toContain(i.name.sv);
  });

  it("serves stale with X-Content-Stale and no ETag on a warm isolate when D1 throws", async () => {
    const { binding, state } = faulty(db);
    const { get } = pipeline(binding);
    await get("/");
    state.mode = "throw";
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Stale")).toBe("1");
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("serves stale when only the full re-read fails after a save (version read succeeds)", async () => {
    const { binding } = faulty(db);
    const { get } = pipeline(binding);
    await get("/");
    await db.prepare("UPDATE menu_items SET price_ore = 9900 WHERE site_id = 'bistro' AND id = ?").bind(ITEM).run();
    const spy = vi.spyOn(binding, "batch").mockImplementation(() => Promise.reject(new Error("D1_ERROR: overloaded")));
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Stale")).toBe("1");
    spy.mockRestore();
  });

  it("falls back to the cached copy within 1.5 s when the version read hangs (ADR-011 §3)", async () => {
    const { binding, state } = faulty(db);
    const { get } = pipeline(binding);
    await get("/");
    state.mode = "hang";
    const timeout = new Promise<"timed out">((r) => setTimeout(() => r("timed out"), 2500));
    const res = await Promise.race([get("/"), timeout]);
    expect(res).not.toBe("timed out");
    expect((res as Response).headers.get("X-Content-Stale")).toBe("1");
  }, 10_000);

  it("shows the emergency page within 1.5 s on a cold isolate when D1 hangs (ADR-011 §3)", async () => {
    const { binding, state } = faulty(db);
    state.mode = "hang";
    const { get } = pipeline(binding);
    const timeout = new Promise<"timed out">((r) => setTimeout(() => r("timed out"), 2500));
    const res = await Promise.race([get("/"), timeout]);
    expect(res).not.toBe("timed out");
    expect((res as Response).status).toBe(503);
  }, 10_000);
});

describe("content that D1 accepts but the schema rejects", () => {
  // The CHECKs leave length caps and vocabularies to the app (0001_content.sql header), so a
  // hand-written query or an admin bug can store a 81-character name.
  const tooLong = "x".repeat(81);

  it("keeps serving the held copy, and does not re-export the whole site on every request", async () => {
    const { get } = pipeline(db);
    await get("/");
    await db.prepare("UPDATE menu_items SET name_en = ? WHERE site_id = 'bistro' AND id = ?").bind(tooLong, ITEM).run();
    const spy = vi.spyOn(db, "batch");
    for (let i = 0; i < 5; i++) {
      const res = await get("/");
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Content-Stale")).toBe("1");
    }
    // One failed re-read per content version is enough; five requests should not cost five exports.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });

  it("takes a cold isolate to the 503 emergency page (documents the blast radius of one bad row)", async () => {
    await db.prepare("UPDATE menu_items SET name_en = ? WHERE site_id = 'bistro' AND id = ?").bind(tooLong, ITEM).run();
    const { get } = pipeline(db);
    expect((await get("/")).status).toBe(503);
  });
});
