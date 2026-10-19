/**
 * ADR-018 task 3: restoring a deleted dish from its history entry. Same id, original place,
 * photo and highlight when they can be, one "restored" audit row, and the export reads as
 * before. The category is found by id, by slug after a re-seed, or chosen by the owner.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import images from "../../sites/bistro/content/images.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { siteContentSchema } from "../../src/content/schema";
import { exportSite } from "../../src/db/export";
import { adminMenu, deleteCategory, setFeatured } from "../../src/db/menu";
import { deleteMenuItem, getMenuItem, type RepoContext, restoreMenuItem } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { undoableEntry } from "../../src/db/undo";

const db = env.DB;
const SITE = "bistro";
const now = new Date("2026-10-19T12:00:00Z");
const ctx = (): RepoContext => ({ db, siteId: SITE, userId: null, now });
const { theme: _t, ...content } = siteContentSchema(SITE).parse({ settings, hours, menu, pages, gallery, images, theme });

const imageIds = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  if (!imageIds.has(path)) imageIds.set(path, (imageIds.size + 1).toString(16).padStart(64, "0"));
  return { id: imageIds.get(path)!, mime: "image/jpeg" };
};
const seed = () => db.batch(prepare(db, seedStatements(SITE, content as StoredContent, fakeImages)));
/** What `seed --reset` does: the site's content tables go, its history and accounts stay. */
const CONTENT_TABLES = [
  "gallery_images",
  "home_highlights",
  "menu_items",
  "menu_categories",
  "page_content",
  "settings",
  "weekly_hours",
  "hours_exceptions",
  "image_variants",
  "images",
];
const reseed = async () => {
  await db.batch(CONTENT_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(SITE)));
  await seed();
};

const one = <T>(sql: string, ...params: unknown[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .first<T>();
const count = async (sql: string, ...params: unknown[]) => (await one<{ n: number }>(sql, ...params))!.n;
const version = () => one<{ v: number }>("SELECT content_version AS v FROM sites WHERE id = ?", SITE).then((r) => r!.v);
const highlights = async () =>
  (await db.prepare("SELECT item_id FROM home_highlights WHERE site_id = ? ORDER BY position").bind(SITE).all<{ item_id: string }>()).results.map((r) => r.item_id);
/** The dishes of the category holding `id`, in admin order. */
async function orderAround(id: string) {
  const category = (await adminMenu(ctx())).find((c) => c.items.some((i) => i.id === id))!;
  return { categoryId: category.id, order: category.items.map((i) => i.id) };
}
/** Delete and hand back the entry id as the page would carry it. */
async function deleted(id: string) {
  const result = await deleteMenuItem(ctx(), id);
  expect(result).toMatchObject({ ok: true });
  return String((result as { entryId: number }).entryId);
}

// A dish with a photo, not first in a category of at least three, and one on the home page.
const picked = content.menu.categories.flatMap((c) => c.items.map((item, index) => ({ c, item, index }))).find((x) => x.index >= 1 && x.item.image && x.c.items.length >= 3)!;
const MIDDLE = picked.item.id;
const MIDDLE_PHOTO = picked.item.image!;
const FEATURED = content.pages.home.highlights[0];

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await seed();
});

describe("restoreMenuItem", () => {
  it("brings the dish back with the same id, in its place, with its photo, row_version + 1 and one 'restored' row", async () => {
    const before = (await getMenuItem(ctx(), MIDDLE))!;
    const { order } = await orderAround(MIDDLE);
    expect(order.indexOf(MIDDLE)).toBe(picked.index);
    const entry = await deleted(MIDDLE);
    const v = await version();
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: true, photoLost: false, featured: null });
    const after = (await getMenuItem(ctx(), MIDDLE))!;
    expect(after).toEqual({ ...before, rowVersion: before.rowVersion + 1 });
    expect((await orderAround(MIDDLE)).order).toEqual(order);
    expect(await one("SELECT image_id FROM menu_items WHERE site_id = ? AND id = ?", SITE, MIDDLE)).toEqual({ image_id: imageIds.get(MIDDLE_PHOTO) });
    expect(await version()).toBeGreaterThan(v);
    const rows = await db
      .prepare("SELECT action, summary FROM audit_log WHERE site_id = ? AND entity_id = ? ORDER BY id")
      .bind(SITE, MIDDLE)
      .all<{ action: string; summary: string }>();
    expect(rows.results).toEqual([
      { action: "delete", summary: `${before.name.sv}: deleted` },
      { action: "create", summary: `${before.name.sv}: restored` },
    ]);
  });

  it("puts a home-page highlight back", async () => {
    const was = await highlights();
    expect(was).toContain(FEATURED);
    const entry = await deleted(FEATURED);
    expect(await highlights()).not.toContain(FEATURED);
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: true, photoLost: false, featured: true });
    expect(new Set(await highlights())).toEqual(new Set(was));
  });

  it("leaves the export as it was, highlight order aside", async () => {
    const before = (await exportSite(db, SITE))!;
    const entry = await deleted(FEATURED);
    expect(await restoreMenuItem(ctx(), entry)).toMatchObject({ ok: true });
    const after = (await exportSite(db, SITE))!;
    expect(after.content.menu).toEqual(before.content.menu);
    expect(after.soldOutOn).toEqual(before.soldOutOn);
    expect(new Set(after.content.pages.home.highlights)).toEqual(new Set(before.content.pages.home.highlights));
    expect({ ...after.content, menu: null, pages: null }).toEqual({ ...before.content, menu: null, pages: null });
  });

  it("finds the category by slug after a re-seed gave it a new id", async () => {
    const entry = await deleted(MIDDLE);
    await reseed();
    expect(await getMenuItem(ctx(), MIDDLE)).not.toBeNull(); // the re-seed brought every dish back
    await db.prepare("DELETE FROM menu_items WHERE site_id = ? AND id = ?").bind(SITE, MIDDLE).run(); // but this one goes again, quietly
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: true, photoLost: false, featured: null });
    const category = (await adminMenu(ctx())).find((c) => c.items.some((i) => i.id === MIDDLE))!;
    expect(category.slug).toBe(picked.c.id);
  });

  it("asks for a category when neither id nor slug matches, and takes the owner's choice", async () => {
    const { categoryId } = await orderAround(MIDDLE);
    const entry = await deleted(MIDDLE);
    expect(await deleteCategory(ctx(), categoryId)).toEqual({ ok: true });
    const n = await count("SELECT count(*) AS n FROM audit_log WHERE site_id = ?", SITE);
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: false, error: "needs-category" });
    expect(await getMenuItem(ctx(), MIDDLE)).toBeNull();
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE site_id = ?", SITE)).toBe(n);
    const other = (await adminMenu(ctx())).find((c) => c.slug !== picked.c.id)!;
    expect(await restoreMenuItem(ctx(), entry, other.id)).toEqual({ ok: true, photoLost: false, featured: null });
    const placed = (await adminMenu(ctx())).find((c) => c.id === other.id)!;
    // The original position, clamped to the category's length.
    expect(placed.items.map((i) => i.id).indexOf(MIDDLE)).toBe(Math.min(picked.index, other.items.length));
  });

  it("comes back without its photo when the photo has been deleted since", async () => {
    const entry = await deleted(MIDDLE);
    const imageId = imageIds.get(MIDDLE_PHOTO)!;
    await db.prepare("DELETE FROM images WHERE site_id = ? AND id = ?").bind(SITE, imageId).run();
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: true, photoLost: true, featured: null });
    expect(await one("SELECT image_id FROM menu_items WHERE site_id = ? AND id = ?", SITE, MIDDLE)).toEqual({ image_id: null });
  });

  it("isn't featured again when the home page is full, and says so", async () => {
    const entry = await deleted(FEATURED);
    expect(await setFeatured(ctx(), MIDDLE, true)).toEqual({ ok: true });
    expect((await highlights()).length).toBe(3);
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: true, photoLost: false, featured: false });
    expect(await highlights()).not.toContain(FEATURED);
    expect(await getMenuItem(ctx(), FEATURED)).not.toBeNull();
  });

  it("deleted, restored and deleted again: only the newest entry can be undone", async () => {
    const first = await deleted(MIDDLE);
    expect(await restoreMenuItem(ctx(), first)).toMatchObject({ ok: true });
    const second = await deleted(MIDDLE);
    expect(await undoableEntry(ctx(), first)).toBeNull();
    expect(await restoreMenuItem(ctx(), first)).toEqual({ ok: false, error: "not-found" });
    expect(await restoreMenuItem(ctx(), second)).toMatchObject({ ok: true });
    expect(await getMenuItem(ctx(), MIDDLE)).not.toBeNull();
  });

  it("a second undo of the same entry writes nothing and reads as already back", async () => {
    const entry = await deleted(MIDDLE);
    expect(await restoreMenuItem(ctx(), entry)).toMatchObject({ ok: true });
    const n = await count("SELECT count(*) AS n FROM audit_log WHERE site_id = ?", SITE);
    const { order } = await orderAround(MIDDLE);
    expect(await restoreMenuItem(ctx(), entry)).toEqual({ ok: false, error: "already-back" });
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE site_id = ?", SITE)).toBe(n);
    expect((await orderAround(MIDDLE)).order).toEqual(order);
    expect(await count("SELECT count(*) AS n FROM menu_items WHERE site_id = ? AND id = ?", SITE, MIDDLE)).toBe(1);
  });
});
