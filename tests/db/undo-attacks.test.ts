/**
 * ADR-018 task 4: what a restore refuses, and what it never writes twice. Another site's
 * entry, a non-delete entry, a purged one and malformed ids all read the same ("not-found")
 * with nothing written; a replay or two restores at once write exactly one dish and one row;
 * a hand-written snapshot the schema rejects writes nothing; the purge takes the snapshot
 * with its row.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AUDIT_RETENTION_DAYS, purgeStatements } from "../../src/auth/purge";
import { siteContentSchema } from "../../src/content/schema";
import { deleteCategory, renameCategory } from "../../src/db/menu";
import { deleteMenuItem, getMenuItem, isoSeconds, type RepoContext, restoreMenuItem } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { undoableEntry } from "../../src/db/undo";

const db = env.DB;
const now = new Date("2026-10-19T12:00:00Z");
const ctx = (siteId: string): RepoContext => ({ db, siteId, userId: null, now });
const bistro = ctx("bistro");
const abena = ctx("westafrican");

const imageIds = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  if (!imageIds.has(path)) imageIds.set(path, (imageIds.size + 1).toString(16).padStart(64, "0"));
  return { id: imageIds.get(path)!, mime: "image/jpeg" };
};
async function load(site: "bistro" | "westafrican") {
  const [settings, hours, menu, pages, gallery, images, theme] = await Promise.all(
    ["settings", "hours", "menu", "pages", "gallery", "images"]
      .map((f) => import(`../../sites/${site}/content/${f}.json`).then((m) => m.default))
      .concat(import(`../../sites/${site}/theme.json`).then((m) => m.default)),
  );
  const { theme: _t, ...content } = siteContentSchema(site).parse({ settings, hours, menu, pages, gallery, images, theme });
  return content as StoredContent & { menu: { categories: Array<{ id: string; items: Array<{ id: string; name: { sv: string } }> }> } };
}

const count = async (sql: string, ...params: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;
const audits = (site: string) => count("SELECT count(*) AS n FROM audit_log WHERE site_id = ?", site);
const dishes = (site: string) => count("SELECT count(*) AS n FROM menu_items WHERE site_id = ?", site);
/** Everything that could change, so "nothing written" is one comparison. */
const state = async () => ({
  bistro: { audits: await audits("bistro"), dishes: await dishes("bistro"), version: await count("SELECT content_version AS n FROM sites WHERE id = 'bistro'") },
  abena: { audits: await audits("westafrican"), dishes: await dishes("westafrican"), version: await count("SELECT content_version AS n FROM sites WHERE id = 'westafrican'") },
});
async function deleted(ctx: RepoContext, id: string) {
  const result = await deleteMenuItem(ctx, id);
  expect(result).toMatchObject({ ok: true });
  return String((result as { entryId: number }).entryId);
}
/** A delete entry with a snapshot written by hand, as a tampered or outdated row. */
async function plantedEntry(payload: string, entityId: string) {
  await db
    .prepare("INSERT INTO audit_log (site_id, user_id, at, entity, entity_id, action, summary, payload) VALUES ('bistro', NULL, ?, 'menu_item', ?, 'delete', 'x: deleted', ?)")
    .bind(isoSeconds(now), entityId, payload)
    .run();
  return String((await db.prepare("SELECT max(id) AS id FROM audit_log").first<{ id: number }>())!.id);
}

let BISTRO_DISH: string;
let ABENA_DISH: string;
let BISTRO_CATEGORY: string;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  const [b, a] = [await load("bistro"), await load("westafrican")];
  await db.batch(prepare(db, seedStatements("bistro", b, fakeImages)));
  await db.batch(prepare(db, seedStatements("westafrican", a, fakeImages)));
  BISTRO_DISH = b.menu.categories[1].items[0].id;
  ABENA_DISH = a.menu.categories[1].items[0].id;
  BISTRO_CATEGORY = (await db.prepare("SELECT id FROM menu_categories WHERE site_id = 'bistro' AND slug = ?").bind(b.menu.categories[1].id).first<{ id: string }>())!.id;
});

describe("what a restore refuses, writing nothing", () => {
  it("another site's entry", async () => {
    const entry = await deleted(abena, ABENA_DISH);
    const before = await state();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "not-found" });
    expect(await undoableEntry(bistro, entry)).toBeNull();
    expect(await state()).toEqual(before);
    expect(await getMenuItem(abena, ABENA_DISH)).toBeNull(); // still deleted on its own site
  });

  it("an entry that isn't a dish delete: an edit, and a category delete", async () => {
    expect(await renameCategory(bistro, BISTRO_CATEGORY, 0, { sv: "Ny", en: "New" })).toMatchObject({ ok: true });
    const edit = String((await db.prepare("SELECT max(id) AS id FROM audit_log").first<{ id: number }>())!.id);
    expect(await deleteCategory(bistro, BISTRO_CATEGORY)).toEqual({ ok: true });
    const category = String((await db.prepare("SELECT max(id) AS id FROM audit_log").first<{ id: number }>())!.id);
    const before = await state();
    for (const entry of [edit, category]) expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "not-found" });
    expect(await state()).toEqual(before);
  });

  it("a purged entry", async () => {
    const entry = await deleted(bistro, BISTRO_DISH);
    const later = new Date(now.getTime() + (AUDIT_RETENTION_DAYS + 1) * 86_400_000);
    await db.batch(prepare(db, purgeStatements("bistro", later)));
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE id = ?", Number(entry))).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE payload IS NOT NULL")).toBe(0); // the snapshot went with its row
    const before = await state();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "not-found" });
    expect(await state()).toEqual(before);
  });

  it.each(["", "0", "-1", "1.5", "1e3", "abc", "1 OR 1=1", "99999999999999999", " 1", "1\n", "١"])("a malformed entry id %j", async (entry) => {
    await deleted(bistro, BISTRO_DISH);
    const before = await state();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "not-found" });
    expect(await state()).toEqual(before);
  });

  it("an entry whose dish is already back: says so, writes nothing", async () => {
    const entry = await deleted(bistro, BISTRO_DISH);
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    const before = await state();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "already-back" });
    expect(await state()).toEqual(before);
  });
});

describe("a snapshot the schema rejects", () => {
  const good = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      item: {
        id: "planted00001",
        name: { sv: "Planterad", en: "Planted" },
        description: { sv: "Rätt", en: "Dish" },
        price: 10000,
        tags: [],
        allergens: [],
        available: true,
        ...over,
      },
      categoryId: "nosuchcat001",
      categorySlug: "mains",
      position: 0,
      soldOutOn: null,
      imageId: null,
      rowVersion: 0,
      highlight: null,
    });

  it("restores a well-formed planted snapshot (the control case)", async () => {
    const entry = await plantedEntry(good(), "planted00001");
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: true, photoLost: false, featured: null });
    expect(await getMenuItem(bistro, "planted00001")).toMatchObject({ name: { sv: "Planterad" } });
  });

  it.each([
    ["a tag no longer in the vocabulary", good({ tags: ["keto"] })],
    ["an item id that isn't the entry's", good({ id: "someoneelse1" })],
    ["a price over the limit", good({ price: 10000001 })],
    ["a missing field", good().replace(',"available":true', "")],
    // Not JSON at all can't be stored: the column's CHECK refuses it (migration 0007).
    ["a JSON object that isn't a snapshot", '{"v":1}'],
    ["an unknown snapshot version", good().replace('"v":1', '"v":2')],
  ])("%s: invalid, nothing written", async (_what, payload) => {
    const entry = await plantedEntry(payload, "planted00001");
    const before = await state();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "invalid" });
    expect(await state()).toEqual(before);
    expect(await getMenuItem(bistro, "planted00001")).toBeNull();
  });
});

describe("a restore happens once", () => {
  it("two restores at once: one dish, one 'restored' row, the other reads as already back or not found", async () => {
    const entry = await deleted(bistro, BISTRO_DISH);
    const before = await state();
    const results = await Promise.all([restoreMenuItem(bistro, entry), restoreMenuItem(bistro, entry)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { error: string }).error)).toEqual([expect.stringMatching(/^(already-back|not-found)$/)]);
    expect(await count("SELECT count(*) AS n FROM menu_items WHERE site_id = 'bistro' AND id = ?", BISTRO_DISH)).toBe(1);
    expect(await audits("bistro")).toBe(before.bistro.audits + 1);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro' AND entity_id = ? AND action = 'create'", BISTRO_DISH)).toBe(1);
  });
});
