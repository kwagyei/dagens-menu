/**
 * ADR-018 task 2: deleting a dish saves a snapshot on its audit row, built in SQL from the
 * row itself. Parity over every seeded dish of both demos: the snapshot, parsed, equals what
 * getMenuItem read just before, with the category, position, photo and highlight.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { siteContentSchema } from "../../src/content/schema";
import { deleteCategory } from "../../src/db/menu";
import { deleteMenuItem, getMenuItem, type RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { parseSnapshot, undoableEntry } from "../../src/db/undo";

const db = env.DB;
const now = new Date("2026-10-19T12:00:00Z");
const ctx = (siteId: string): RepoContext => ({ db, siteId, userId: null, now });

const SITES = ["bistro", "westafrican"] as const;
const imageIds = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  if (!imageIds.has(path)) imageIds.set(path, (imageIds.size + 1).toString(16).padStart(64, "0"));
  return { id: imageIds.get(path)!, mime: "image/jpeg" };
};

async function load(site: (typeof SITES)[number]) {
  const [settings, hours, menu, pages, gallery, images, theme] = await Promise.all(
    ["settings", "hours", "menu", "pages", "gallery", "images"]
      .map((f) => import(`../../sites/${site}/content/${f}.json`).then((m) => m.default))
      .concat(import(`../../sites/${site}/theme.json`).then((m) => m.default)),
  );
  const { theme: _t, ...content } = siteContentSchema(site).parse({ settings, hours, menu, pages, gallery, images, theme });
  return content as StoredContent & {
    menu: { categories: Array<{ id: string; items: Array<{ id: string; image?: string }> }> };
    pages: { home: { highlights: string[] } };
  };
}

// The seed gives categories fresh ids and stores the content's id as the slug, so a category's
// stored id is found by that.
const storedCategoryId = async (site: string, slug: string) => (await row<{ id: string }>("SELECT id FROM menu_categories WHERE site_id = ? AND slug = ?", site, slug))!.id;

const row = <T>(sql: string, ...params: unknown[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .first<T>();

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  for (const site of SITES) await db.batch(prepare(db, seedStatements(site, await load(site), fakeImages)));
});

describe.each(SITES)("%s: the snapshot on delete", (site) => {
  it("matches the dish as read before the delete, for every seeded dish", async () => {
    const content = await load(site);
    for (const category of content.menu.categories) {
      const categoryId = await storedCategoryId(site, category.id);
      for (const [index, seeded] of category.items.entries()) {
        const before = (await getMenuItem(ctx(site), seeded.id))!;
        const highlight = content.pages.home.highlights.indexOf(seeded.id);
        const result = await deleteMenuItem(ctx(site), seeded.id);
        expect(result).toMatchObject({ ok: true });
        const entry = await undoableEntry(ctx(site), String((result as { entryId: number }).entryId));
        expect(entry, seeded.id).not.toBeNull();
        const snapshot = parseSnapshot(entry!.payload, site, seeded.id);
        expect(snapshot, seeded.id).toEqual({
          v: 1,
          item: {
            id: before.id,
            name: before.name,
            description: before.description,
            price: before.priceOre,
            tags: before.tags,
            allergens: before.allergens,
            available: before.available,
          },
          categoryId,
          categorySlug: category.id,
          position: index,
          soldOutOn: before.soldOutOn,
          imageId: seeded.image ? imageIds.get(seeded.image)! : null,
          rowVersion: before.rowVersion,
          highlight: highlight === -1 ? null : highlight,
        });
      }
    }
  });

  it("writes the snapshot and the delete as one transaction, and returns that entry's id", async () => {
    const content = await load(site);
    const dish = content.menu.categories[0].items[0];
    const audits = () => row<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE site_id = ?", site).then((r) => r!.n);
    const n = await audits();
    const result = await deleteMenuItem(ctx(site), dish.id);
    expect(result.ok).toBe(true);
    expect(await audits()).toBe(n + 1);
    const newest = await row<{ id: number; action: string; summary: string; has_payload: number }>(
      "SELECT id, action, summary, payload IS NOT NULL AS has_payload FROM audit_log WHERE site_id = ? ORDER BY id DESC LIMIT 1",
      site,
    );
    expect(newest).toMatchObject({ id: (result as { entryId: number }).entryId, action: "delete", has_payload: 1 });
    expect(newest!.summary).toMatch(/: deleted$/);
    expect(await getMenuItem(ctx(site), dish.id)).toBeNull();
    // Deleting it again: no row to snapshot, nothing to delete, nothing written.
    expect(await deleteMenuItem(ctx(site), dish.id)).toEqual({ ok: false, error: "not-found" });
    expect(await audits()).toBe(n + 1);
  });

  it("a dish removed by deleting its category gets no snapshot of its own", async () => {
    const content = await load(site);
    const category = content.menu.categories[0];
    const categoryId = await storedCategoryId(site, category.id);
    expect(await deleteCategory(ctx(site), categoryId)).toEqual({ ok: true });
    for (const dish of category.items) {
      expect(await row("SELECT 1 AS x FROM audit_log WHERE site_id = ? AND entity = 'menu_item' AND entity_id = ?", site, dish.id)).toBeNull();
    }
    const entry = await row<{ has_payload: number }>("SELECT payload IS NOT NULL AS has_payload FROM audit_log WHERE site_id = ? AND entity_id = ?", site, categoryId);
    expect(entry).toEqual({ has_payload: 0 });
  });

  it("another site's dish is not found, and nothing is written", async () => {
    const other = site === "bistro" ? "westafrican" : "bistro";
    const dish = (await load(other)).menu.categories[0].items[0];
    const n = (await row<{ n: number }>("SELECT count(*) AS n FROM audit_log"))!.n;
    expect(await deleteMenuItem(ctx(site), dish.id)).toEqual({ ok: false, error: "not-found" });
    expect((await row<{ n: number }>("SELECT count(*) AS n FROM audit_log"))!.n).toBe(n);
    expect(await getMenuItem(ctx(other), dish.id)).not.toBeNull();
  });
});
