/**
 * Tester (M2.3): trying to break the repository — races on row_version, same ids on two
 * sites, guards that match zero or several rows, audit summaries, sold-out dates at DST and
 * midnight, invalid input, and what is recorded in updated_by / updated_at.
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
import { commitIf, deleteMenuItem, getMenuItem, type MenuItemEdit, type MenuItemRecord, type RepoContext, setSoldOut, updateMenuItem } from "../../src/db/repository";
import { formatPrice } from "../../src/content/load";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare, stmt } from "../../src/db/sql";

const db = env.DB;
const NOW = new Date("2026-10-16T10:00:00Z");
const ctx = (siteId: string, now = NOW, userId: string | null = null): RepoContext => ({ db, siteId, userId, now });
const bistro = ctx("bistro");
const westafrican = ctx("westafrican");

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
const none = () => {
  throw new Error("no images expected");
};

const ITEM = bistroMenu.categories[0].items[0].id;
const ITEM2 = bistroMenu.categories[0].items[1].id;
const version = (site: string) => db.prepare("SELECT content_version FROM sites WHERE id = ?").bind(site).first<number>("content_version");
const audits = (site = "bistro") =>
  db.prepare("SELECT user_id, entity, entity_id, action, summary FROM audit_log WHERE site_id = ? AND action <> 'seed' ORDER BY id").bind(site).all();
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
  await db.batch(prepare(db, seedStatements("bistro", content.bistro, none)));
  await db.batch(prepare(db, seedStatements("westafrican", content.westafrican, none)));
});

describe("concurrency", () => {
  it("lets exactly one of two racing saves with the same row_version win", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    const v0 = await version("bistro");
    const [a, b] = await Promise.all([
      updateMenuItem(bistro, ITEM, item.rowVersion, { ...editOf(item), priceOre: 15500 }),
      updateMenuItem(bistro, ITEM, item.rowVersion, { ...editOf(item), priceOre: 9900 }),
    ]);
    const results = [a, b].map((r) => (r.ok ? "ok" : r.error)).sort();
    expect(results).toEqual(["conflict", "ok"]);
    const winner = a.ok ? 15500 : 9900;
    expect((await getMenuItem(bistro, ITEM))!.priceOre).toBe(winner);
    expect(await version("bistro")).toBe(v0! + 1);
    expect((await audits()).results).toHaveLength(1);
  });

  it("does not lose a sold-out tap that lands between loading and saving the edit form", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    await setSoldOut(bistro, ITEM, true);
    expect(await updateMenuItem(bistro, ITEM, item.rowVersion, { ...editOf(item), priceOre: 15500 })).toEqual({ ok: true });
    const after = (await getMenuItem(bistro, ITEM))!;
    expect([after.priceOre, after.soldOutOn]).toEqual([15500, "2026-10-16"]);
  });

  it("survives ten parallel sold-out taps: every tap succeeds, each real change is audited once", async () => {
    const v0 = await version("bistro");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => setSoldOut(bistro, ITEM, i % 2 === 0)));
    expect(results.every((r) => r.ok)).toBe(true);
    const changes = (await audits()).results.length;
    // Repeated taps that change nothing write nothing; every change that happened is audited.
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(changes).toBeLessThanOrEqual(10);
    expect(await version("bistro")).toBeGreaterThanOrEqual(v0! + changes);
  });
});

describe("the same item id on two sites", () => {
  beforeEach(async () => {
    // Ids are unique per site only: give westafrican a dish with the bistro dish's id.
    const cat = await db.prepare("SELECT id FROM menu_categories WHERE site_id = 'westafrican' LIMIT 1").first<string>("id");
    await db
      .prepare(
        `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position)
         VALUES ('westafrican', ?, ?, 'Tvilling', 'Twin', 'B', 'B', 100, 99)`,
      )
      .bind(ITEM, cat)
      .run();
  });

  it("deletes only the calling site's dish", async () => {
    expect(await deleteMenuItem(westafrican, ITEM)).toMatchObject({ ok: true });
    expect(await getMenuItem(westafrican, ITEM)).toBeNull();
    expect((await getMenuItem(bistro, ITEM))?.name.sv).toBe(bistroMenu.categories[0].items[0].name.sv);
  });

  it("marks only the calling site's dish sold out and bumps only its version", async () => {
    const vb = await version("bistro");
    expect(await setSoldOut(westafrican, ITEM, true)).toEqual({ ok: true });
    expect((await getMenuItem(bistro, ITEM))!.soldOutOn).toBeNull();
    expect(await version("bistro")).toBe(vb);
  });

  it("edits only the calling site's dish, even with a matching row_version", async () => {
    const wa = (await getMenuItem(westafrican, ITEM))!;
    expect(await updateMenuItem(westafrican, ITEM, wa.rowVersion, { ...editOf(wa), priceOre: 1 })).toEqual({ ok: true });
    expect((await getMenuItem(bistro, ITEM))!.priceOre).toBe(bistroMenu.categories[0].items[0].price);
  });
});

describe("commitIf", () => {
  const entry = { entity: "menu_item", entityId: ITEM, action: "update" as const, summary: "x" };

  it("writes nothing when the guard matches no row", async () => {
    const v0 = await version("bistro");
    const matched = await commitIf(bistro, stmt("UPDATE menu_items SET price_ore = 1 WHERE site_id = ? AND id = 'nosuchitem00'", "bistro"), entry);
    expect(matched).toBe(false);
    expect(await version("bistro")).toBe(v0);
    expect((await audits()).results).toHaveLength(0);
  });

  it("bumps the version and audits when the guard matches several rows (e.g. a reorder)", async () => {
    const v0 = await version("bistro");
    const matched = await commitIf(bistro, stmt("UPDATE menu_items SET position = position + 100 WHERE site_id = ? AND id IN (?, ?)", "bistro", ITEM, ITEM2), {
      ...entry,
      action: "reorder",
    });
    expect(matched).toBe(true);
    // The data did change...
    expect(await db.prepare("SELECT count(*) AS n FROM menu_items WHERE position >= 100").first("n")).toBe(2);
    // ...so the page caches must see a new version and the change must be in the audit log.
    expect(await version("bistro")).toBeGreaterThan(v0!);
    expect((await audits()).results).toHaveLength(1);
  });
});

describe("audit summaries", () => {
  it("names the stored (cleaned) name and reports no change when only invisible characters differ", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    const soft = item.name.sv.slice(0, 3) + "­" + item.name.sv.slice(3); // soft hyphen, stripped by the schema
    expect(await updateMenuItem(bistro, ITEM, item.rowVersion, { ...editOf(item), name: { ...item.name, sv: soft } })).toEqual({ ok: true });
    expect((await getMenuItem(bistro, ITEM))!.name.sv).toBe(item.name.sv);
    expect((await audits()).results[0]).toMatchObject({ summary: `${item.name.sv}: saved without changes` });
  });

  it("describes a price, availability and allergen change together", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    await updateMenuItem(bistro, ITEM, item.rowVersion, { ...editOf(item), priceOre: 14550, available: false, allergens: [] });
    expect((await audits()).results[0]).toMatchObject({
      summary: `${item.name.sv}: price ${formatPrice(14500)} → ${formatPrice(14550)}, allergens, taken off the menu`,
    });
  });

  it("records the sold-out date and who did it", async () => {
    await setSoldOut(ctx("bistro", NOW, "user00000001"), ITEM, true);
    expect((await audits()).results[0]).toMatchObject({ user_id: "user00000001", action: "update", summary: expect.stringContaining("sold out 2026-10-16") });
  });

  it("still bumps the content version on a save without changes (observation)", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    const v0 = await version("bistro");
    await updateMenuItem(bistro, ITEM, item.rowVersion, editOf(item));
    expect(await version("bistro")).toBe(v0! + 1);
    expect((await getMenuItem(bistro, ITEM))!.rowVersion).toBe(item.rowVersion + 1);
  });
});

describe("sold-out date is the Stockholm calendar day", () => {
  it.each<[string, string, string]>([
    ["one second before midnight, summer time", "2026-10-16T21:59:59Z", "2026-10-16"],
    ["midnight, summer time", "2026-10-16T22:00:00Z", "2026-10-17"],
    ["the night clocks go back, before the change", "2026-10-25T00:30:00Z", "2026-10-25"],
    ["the repeated hour 02:30 CET after clocks go back", "2026-10-25T01:30:00Z", "2026-10-25"],
    ["the evening after clocks go back (CET, UTC+1)", "2026-10-25T22:59:59Z", "2026-10-25"],
    ["midnight after clocks go back", "2026-10-25T23:00:00Z", "2026-10-26"],
    ["just before midnight before spring forward", "2026-03-28T22:59:59Z", "2026-03-28"],
    ["midnight before spring forward", "2026-03-28T23:00:00Z", "2026-03-29"],
    ["the skipped hour in spring", "2026-03-29T01:30:00Z", "2026-03-29"],
    ["new year's eve, UTC still in the old year", "2026-12-31T23:30:00Z", "2027-01-01"],
  ])("%s (%s) → %s", async (_name, iso, date) => {
    expect(await setSoldOut(ctx("bistro", new Date(iso)), ITEM, true)).toEqual({ ok: true });
    expect((await getMenuItem(bistro, ITEM))!.soldOutOn).toBe(date);
  });
});

describe("invalid input", () => {
  it.each<[string, Partial<MenuItemEdit>]>([
    ["a NaN price", { priceOre: Number.NaN }],
    ["an infinite price", { priceOre: Number.POSITIVE_INFINITY }],
    ["a fractional price", { priceOre: 1.5 }],
    ["a price over 100 000 kr", { priceOre: 10_000_001 }],
    ["an 81-character name", { name: { sv: "x".repeat(81), en: "x" } }],
    ["a tag outside the vocabulary", { tags: ["halal"] }],
    ["a repeated allergen", { allergens: ["milk", "milk"] }],
    ["a name that is only a zero-width space", { name: { sv: "​", en: "Soup" } }],
  ])("rejects %s and writes nothing", async (_name, patch) => {
    const item = (await getMenuItem(bistro, ITEM))!;
    const v0 = await version("bistro");
    const result = await updateMenuItem(bistro, ITEM, item.rowVersion, { ...editOf(item), ...patch });
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(await getMenuItem(bistro, ITEM)).toEqual(item);
    expect(await version("bistro")).toBe(v0);
  });

  it("treats an injection attempt in the id as an unknown dish", async () => {
    const evil = "x' OR '1'='1";
    expect(await getMenuItem(bistro, evil)).toBeNull();
    expect(await setSoldOut(bistro, evil, true)).toEqual({ ok: false, error: "not-found" });
    expect(await deleteMenuItem(bistro, evil)).toEqual({ ok: false, error: "not-found" });
    expect(await db.prepare("SELECT count(*) AS n FROM menu_items WHERE site_id = 'bistro'").first("n")).toBe(14);
  });

  it("reports a conflict, not a success, for a row_version from the future", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    expect(await updateMenuItem(bistro, ITEM, item.rowVersion + 5, editOf(item))).toEqual({ ok: false, error: "conflict", current: item.rowVersion });
  });
});

describe("updated_by and updated_at", () => {
  it("records the user and time of an edit and of a sold-out tap", async () => {
    const item = (await getMenuItem(bistro, ITEM))!;
    await updateMenuItem(ctx("bistro", NOW, "user00000001"), ITEM, item.rowVersion, editOf(item));
    const row1 = await db.prepare("SELECT updated_by, updated_at FROM menu_items WHERE site_id = 'bistro' AND id = ?").bind(ITEM).first();
    expect(row1).toEqual({ updated_by: "user00000001", updated_at: "2026-10-16T10:00:00Z" });
    await setSoldOut(ctx("bistro", new Date("2026-10-16T11:00:00Z"), "user00000002"), ITEM, true);
    const row2 = await db.prepare("SELECT updated_by, updated_at FROM menu_items WHERE site_id = 'bistro' AND id = ?").bind(ITEM).first();
    expect(row2).toEqual({ updated_by: "user00000002", updated_at: "2026-10-16T11:00:00Z" });
  });

  it("accepts a user id that doesn't exist (no foreign key on updated_by; observation)", async () => {
    expect(await setSoldOut(ctx("bistro", NOW, "ghost0000000"), ITEM, true)).toEqual({ ok: true });
  });

  it("stores times in the same format as the database defaults", async () => {
    await setSoldOut(ctx("bistro", new Date("2026-10-16T10:00:00.789Z")), ITEM, true);
    const at = await db.prepare("SELECT at FROM audit_log WHERE action = 'update'").first<string>("at");
    expect(at).toBe("2026-10-16T10:00:00Z");
  });
});
