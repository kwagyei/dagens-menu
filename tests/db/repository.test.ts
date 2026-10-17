/**
 * Plan M2.3: the repository scopes everything to its site, writes atomically with the
 * content version and the audit log, and rejects stale or invalid edits without a trace.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import bistroGallery from "../../sites/bistro/content/gallery.json";
import bistroImages from "../../sites/bistro/content/images.json";
import bistroHours from "../../sites/bistro/content/hours.json";
import bistroMenu from "../../sites/bistro/content/menu.json";
import bistroPages from "../../sites/bistro/content/pages.json";
import bistroSettings from "../../sites/bistro/content/settings.json";
import waGallery from "../../sites/westafrican/content/gallery.json";
import waImages from "../../sites/westafrican/content/images.json";
import waHours from "../../sites/westafrican/content/hours.json";
import waMenu from "../../sites/westafrican/content/menu.json";
import waPages from "../../sites/westafrican/content/pages.json";
import waSettings from "../../sites/westafrican/content/settings.json";
import {
  commit,
  deleteMenuItem,
  getMenuItem,
  type MenuItemEdit,
  type MenuItemRecord,
  type RepoContext,
  setSoldOut,
  updateMenuItem,
} from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare, stmt } from "../../src/db/sql";

const db = env.DB;
const NOW = new Date("2026-10-16T10:00:00Z");
const ctx = (siteId: string, now = NOW): RepoContext => ({ db, siteId, userId: null, now });
const bistro = ctx("bistro");
const westafrican = ctx("westafrican");

// Seed without images: these tests are about the menu, and images need real hashes.
const noImages = (c: StoredContent): StoredContent => ({
  ...c,
  menu: { categories: c.menu.categories.map((cat) => ({ ...cat, items: cat.items.map(({ image: _i, ...item }) => item) })) },
  pages: {
    home: { tagline: c.pages.home.tagline, highlights: c.pages.home.highlights, pullQuote: c.pages.home.pullQuote },
    menu: {},
    about: { story: c.pages.about.story, chef: c.pages.about.chef },
  },
  gallery: { images: [] },
  images: [],
});
const content = {
  bistro: noImages({ settings: bistroSettings, hours: bistroHours, menu: bistroMenu, pages: bistroPages, gallery: bistroGallery, images: bistroImages } as StoredContent),
  westafrican: noImages({ settings: waSettings, hours: waHours, menu: waMenu, pages: waPages, gallery: waGallery, images: waImages } as StoredContent),
};
const noImageResolver = () => {
  throw new Error("no images expected");
};

const BISTRO_ITEM = bistroMenu.categories[0].items[0].id;
const HIGHLIGHTED = bistroPages.home.highlights[0];

const version = (site: string) => db.prepare("SELECT content_version FROM sites WHERE id = ?").bind(site).first<number>("content_version");
const auditCount = () => db.prepare("SELECT count(*) AS n FROM audit_log WHERE action <> 'seed'").first<number>("n");
const editOf = (item: MenuItemRecord): MenuItemEdit => ({
  name: item.name,
  description: item.description,
  priceOre: item.priceOre,
  tags: item.tags,
  allergens: item.allergens,
  available: item.available,
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content.bistro, noImageResolver)));
  await db.batch(prepare(db, seedStatements("westafrican", content.westafrican, noImageResolver)));
});

describe("updateMenuItem", () => {
  it("saves the edit, moves the content version on and records who changed what", async () => {
    const before = (await getMenuItem(bistro, BISTRO_ITEM))!;
    const v0 = await version("bistro");
    const result = await updateMenuItem({ ...bistro, userId: null }, BISTRO_ITEM, before.rowVersion, { ...editOf(before), priceOre: 15500 });
    expect(result).toEqual({ ok: true });
    const after = (await getMenuItem(bistro, BISTRO_ITEM))!;
    expect(after.priceOre).toBe(15500);
    expect(after.rowVersion).toBe(before.rowVersion + 1);
    expect(await version("bistro")).toBeGreaterThan(v0!);
    const entry = await db.prepare("SELECT entity, entity_id, action, summary FROM audit_log WHERE action = 'update'").first();
    expect(entry).toEqual({ entity: "menu_item", entity_id: BISTRO_ITEM, action: "update", summary: `${before.name.sv}: price 145 kr → 155 kr` });
  });

  it("refuses a stale edit as a conflict and writes nothing", async () => {
    const item = (await getMenuItem(bistro, BISTRO_ITEM))!;
    await updateMenuItem(bistro, BISTRO_ITEM, item.rowVersion, { ...editOf(item), priceOre: 15500 });
    const v1 = await version("bistro");
    const audits = await auditCount();
    // A second editor still holds the form rendered from the original row_version.
    const result = await updateMenuItem(bistro, BISTRO_ITEM, item.rowVersion, { ...editOf(item), priceOre: 9900 });
    expect(result).toEqual({ ok: false, error: "conflict", current: item.rowVersion + 1 });
    expect((await getMenuItem(bistro, BISTRO_ITEM))!.priceOre).toBe(15500);
    expect(await version("bistro")).toBe(v1);
    expect(await auditCount()).toBe(audits);
  });

  it("rejects invalid input before touching the database", async () => {
    const item = (await getMenuItem(bistro, BISTRO_ITEM))!;
    const v0 = await version("bistro");
    const result = await updateMenuItem(bistro, BISTRO_ITEM, item.rowVersion, {
      ...editOf(item),
      name: { sv: "Soppa", en: "​" },
      priceOre: -5,
      allergens: ["shellfish"],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error === "invalid" && result.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["name.en", "price", "allergens.0"]),
    );
    expect((await getMenuItem(bistro, BISTRO_ITEM))!.priceOre).toBe(item.priceOre);
    expect(await version("bistro")).toBe(v0);
  });
});

describe("another site's data", () => {
  it("is not found for reading, editing, sold-out or deleting, and is left untouched", async () => {
    const item = (await getMenuItem(bistro, BISTRO_ITEM))!;
    const versions = [await version("bistro"), await version("westafrican")];
    expect(await getMenuItem(westafrican, BISTRO_ITEM)).toBeNull();
    expect(await updateMenuItem(westafrican, BISTRO_ITEM, item.rowVersion, { ...editOf(item), priceOre: 1 })).toEqual({ ok: false, error: "not-found" });
    expect(await setSoldOut(westafrican, BISTRO_ITEM, true)).toEqual({ ok: false, error: "not-found" });
    expect(await deleteMenuItem(westafrican, BISTRO_ITEM)).toEqual({ ok: false, error: "not-found" });
    expect(await getMenuItem(bistro, BISTRO_ITEM)).toEqual(item);
    expect([await version("bistro"), await version("westafrican")]).toEqual(versions);
    expect(await auditCount()).toBe(0);
  });
});

describe("atomicity", () => {
  it("leaves data and content version unchanged when a batch fails midway", async () => {
    const item = (await getMenuItem(bistro, BISTRO_ITEM))!;
    const v0 = await version("bistro");
    const failing = commit(
      bistro,
      [
        stmt("UPDATE menu_items SET price_ore = 1 WHERE site_id = 'bistro' AND id = ?", BISTRO_ITEM),
        stmt("UPDATE menu_items SET price_ore = -1 WHERE site_id = 'bistro' AND id = ?", BISTRO_ITEM), // violates the CHECK
      ],
      { entity: "menu_item", entityId: BISTRO_ITEM, action: "update", summary: "injected failure" },
    );
    await expect(failing).rejects.toThrow(/CHECK/);
    expect((await getMenuItem(bistro, BISTRO_ITEM))!.priceOre).toBe(item.priceOre);
    expect(await version("bistro")).toBe(v0);
    expect(await auditCount()).toBe(0);
  });
});

describe("setSoldOut", () => {
  it("marks a dish sold out for the restaurant's day, not the UTC day", async () => {
    // 23:30 UTC on 16 Oct is already 01:30 on 17 Oct in Stockholm.
    expect(await setSoldOut(ctx("bistro", new Date("2026-10-16T23:30:00Z")), BISTRO_ITEM, true)).toEqual({ ok: true });
    expect((await getMenuItem(bistro, BISTRO_ITEM))!.soldOutOn).toBe("2026-10-17");
  });

  it("writes nothing when the dish is already in the state asked for", async () => {
    await setSoldOut(bistro, BISTRO_ITEM, true);
    const v = await version("bistro");
    const audits = await auditCount();
    expect(await setSoldOut(bistro, BISTRO_ITEM, true)).toEqual({ ok: true });
    expect(await setSoldOut(bistro, "zzzzzzzzzzzz", false)).toEqual({ ok: false, error: "not-found" });
    expect([await version("bistro"), await auditCount()]).toEqual([v, audits]);
  });

  it("puts a dish back on sale", async () => {
    await setSoldOut(bistro, BISTRO_ITEM, true);
    const v = await version("bistro");
    await setSoldOut(bistro, BISTRO_ITEM, false);
    expect((await getMenuItem(bistro, BISTRO_ITEM))!.soldOutOn).toBeNull();
    expect(await version("bistro")).toBeGreaterThan(v!);
  });
});

describe("deleteMenuItem", () => {
  it("removes the dish and its home-page highlight, in one write that moves the version on", async () => {
    const v0 = await version("bistro");
    expect(await deleteMenuItem(bistro, HIGHLIGHTED)).toEqual({ ok: true });
    expect(await getMenuItem(bistro, HIGHLIGHTED)).toBeNull();
    expect(await db.prepare("SELECT count(*) AS n FROM home_highlights WHERE item_id = ?").bind(HIGHLIGHTED).first("n")).toBe(0);
    expect(await version("bistro")).toBeGreaterThan(v0!);
    expect(await deleteMenuItem(bistro, HIGHLIGHTED)).toEqual({ ok: false, error: "not-found" });
  });
});
