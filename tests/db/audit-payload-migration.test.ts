/**
 * Migration 0007 on production's path (ADR-018 task 1): a database built from 0001–0006 with
 * seeded content and history rows, then 0007. Existing rows keep payload NULL, the column's
 * CHECK holds, today's writes still pass, and the undoable lookup uses the new index.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import imageLibrary from "../../sites/bistro/content/images.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { siteContentSchema } from "../../src/content/schema";
import { deleteMenuItem, type RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { UNDOABLE } from "../../src/db/undo";

const db = env.DB;
const SITE = "bistro";
const { theme: _t, ...content } = siteContentSchema(SITE).parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
// A distinct 64-hex id per curated path; the bytes don't matter here.
const imageIds = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  if (!imageIds.has(path)) imageIds.set(path, imageIds.size.toString(16).padStart(64, "0"));
  return { id: imageIds.get(path)!, mime: "image/jpeg" };
};
const ctx = (): RepoContext => ({ db, siteId: SITE, userId: null, now: new Date("2026-10-19T12:00:00Z") });

const migration = (name: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(name))!;
const apply = (name: string) => db.batch(migration(name).queries.map((q) => db.prepare(q)));
const count = async (sql: string, ...params: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;
const columns = async (table: string) => (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);

const firstDish = content.menu.categories[0].items[0];
/**
 * A JSON object of exactly `chars` ASCII characters. The CHECK's length() counts characters,
 * not bytes (review L3): with ASCII the two agree, so these are the boundary either way.
 */
const objectOf = (chars: number) => JSON.stringify({ v: 1, pad: "x".repeat(chars - JSON.stringify({ v: 1, pad: "" }).length) });
let rowsBefore: number;

beforeAll(async () => {
  // Back to an empty database (children before parents: newest table first), then through 0006.
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC")
    .all<{ name: string }>();
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = true"), ...tables.results.map((t) => db.prepare(`DROP TABLE "${t.name}"`))]);
  for (const name of ["0001", "0002", "0003", "0004", "0005", "0006"]) await apply(name);
  await db.batch(prepare(db, seedStatements(SITE, content as StoredContent, fakeImages)));
  // History as the code before ADR-018 wrote it: a delete and its audit row, no snapshot.
  expect(await columns("audit_log")).not.toContain("payload");
  await db.batch([
    db
      .prepare("INSERT INTO audit_log (site_id, user_id, at, entity, entity_id, action, summary) VALUES (?, NULL, ?, 'menu_item', ?, 'delete', ?)")
      .bind(SITE, "2026-10-18T12:00:00Z", firstDish.id, `${firstDish.name.sv}: deleted`),
    db.prepare("DELETE FROM menu_items WHERE site_id = ? AND id = ?").bind(SITE, firstDish.id),
  ]);
  rowsBefore = await count("SELECT count(*) AS n FROM audit_log");
  await apply("0007");
});

describe("migration 0007", () => {
  it("adds payload to audit_log and keeps every existing row, with payload NULL", async () => {
    expect(await columns("audit_log")).toContain("payload");
    expect(await count("SELECT count(*) AS n FROM audit_log")).toBe(rowsBefore);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE payload IS NOT NULL")).toBe(0);
    expect(rowsBefore).toBeGreaterThan(0);
  });

  it("is expand only: it drops and renames nothing", () => {
    expect(migration("0007").queries.join("\n")).not.toMatch(/\b(DROP|RENAME)\b/i);
  });

  it.each([
    ["not JSON", "{not json"],
    ["a JSON array", "[1, 2]"],
    ["a JSON string", '"text"'],
    ["one character over 16,384", objectOf(16385)],
  ])("refuses a payload that is %s", async (_what, payload) => {
    expect(payload.length).toBeGreaterThanOrEqual(2);
    await expect(
      db
        .prepare("INSERT INTO audit_log (site_id, entity, entity_id, action, summary, payload) VALUES (?, 'menu_item', 'abcdefghijkl', 'delete', 'x', ?)")
        .bind(SITE, payload)
        .run(),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("accepts a JSON object of exactly 16,384 characters", async () => {
    const payload = objectOf(16384);
    expect(payload.length).toBe(16384);
    await db
      .prepare("INSERT INTO audit_log (site_id, entity, entity_id, action, summary, payload) VALUES (?, 'menu_item', 'abcdefghijkl', 'delete', 'x', ?)")
      .bind(SITE, payload)
      .run();
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE payload IS NOT NULL")).toBe(1);
  });

  it("a delete after the migration lands its audit row with a snapshot", async () => {
    const dish = content.menu.categories[0].items[1];
    expect(await deleteMenuItem(ctx(), dish.id)).toMatchObject({ ok: true });
    const row = await db
      .prepare("SELECT action, summary, json_extract(payload, '$.item.id') AS snapshot_of FROM audit_log WHERE site_id = ? AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .bind(SITE, dish.id)
      .first();
    expect(row).toEqual({ action: "delete", summary: `${dish.name.sv}: deleted`, snapshot_of: dish.id });
  });

  it("the entry written before the migration has no snapshot, so it can't be undone", async () => {
    const row = await db.prepare("SELECT payload FROM audit_log WHERE site_id = ? AND entity_id = ?").bind(SITE, firstDish.id).first();
    expect(row).toEqual({ payload: null });
  });

  it("the undoable lookup uses the new index", async () => {
    // The very clause undoableEntry() and the history page use, so the two can't drift (review L3).
    const plan = await db.prepare(`EXPLAIN QUERY PLAN SELECT a.id FROM audit_log a WHERE a.id = ? AND a.site_id = ? AND ${UNDOABLE}`).bind(1, SITE).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toContain("audit_log_entity");
  });
});
