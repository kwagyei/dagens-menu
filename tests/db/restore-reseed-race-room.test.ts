/**
 * The re-seed race with room on the home page (tester, 24 Oct; 21 Oct review M2).
 * undo-attacks.test.ts runs its race with the seed's three highlights, so after
 * the re-seed puts the dish's highlight back the list is full again and the restore's highlight
 * insert is stopped by `count < MAX_HIGHLIGHTS` before `written` or ON CONFLICT is reached.
 * Here one other highlight is removed first, so the highlight statement's own guards decide.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { siteContentSchema } from "../../src/content/schema";
import { deleteMenuItem, getMenuItem, type RepoContext, restoreMenuItem } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-24T12:00:00Z");
const bistro: RepoContext = { db, siteId: "bistro", userId: null, now };

const imageIds = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  if (!imageIds.has(path)) imageIds.set(path, (imageIds.size + 1).toString(16).padStart(64, "0"));
  return { id: imageIds.get(path)!, mime: "image/jpeg" };
};
async function load() {
  const [settings, hours, menu, pages, gallery, images, theme] = await Promise.all(
    ["settings", "hours", "menu", "pages", "gallery", "images"]
      .map((f) => import(`../../sites/bistro/content/${f}.json`).then((m) => m.default))
      .concat(import(`../../sites/bistro/theme.json`).then((m) => m.default)),
  );
  const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, images, theme });
  return content as StoredContent;
}

const count = async (sql: string, ...params: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;
const highlightsOf = (id: string) => count("SELECT count(*) AS n FROM home_highlights WHERE site_id = 'bistro' AND item_id = ?", id);
const restoredRows = (id: string) => count("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro' AND entity_id = ? AND action = 'create'", id);

/** The database, with a "re-seed" of the dish (and optionally its highlight) just before the first batch. */
function reseedBeforeBatch(id: string, categoryId: string, withHighlight: boolean): RepoContext {
  let done = false;
  const wrapped = new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop !== "batch") return Reflect.get(target, prop, receiver);
      return async (statements: D1PreparedStatement[]) => {
        if (!done) {
          done = true;
          const seed = [
            target
              .prepare(
                "INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position) VALUES ('bistro', ?, ?, 'Omseedad', 'Re-seeded', 'Från seed', 'From the seed', 10000, 99)",
              )
              .bind(id, categoryId),
          ];
          if (withHighlight)
            seed.push(
              target
                .prepare(
                  "INSERT INTO home_highlights (site_id, item_id, position) SELECT 'bistro', ?, coalesce(max(position) + 1, 0) FROM home_highlights WHERE site_id = 'bistro'",
                )
                .bind(id),
            );
          await target.batch(seed);
        }
        return target.batch(statements);
      };
    },
  });
  return { ...bistro, db: wrapped };
}

let target: string;
let categoryId: string;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", await load(), fakeImages)));
  const rows = (await db.prepare("SELECT item_id FROM home_highlights WHERE site_id = 'bistro' ORDER BY position").all<{ item_id: string }>()).results;
  expect(rows.length).toBe(3);
  target = rows[0].item_id;
  // Make room: one other highlight goes, so after the target's delete and re-seed there are 2 of 3.
  await db.prepare("DELETE FROM home_highlights WHERE site_id = 'bistro' AND item_id = ?").bind(rows[2].item_id).run();
  categoryId = (await db.prepare("SELECT category_id FROM menu_items WHERE site_id = 'bistro' AND id = ?").bind(target).first<{ category_id: string }>())!.category_id;
});

async function deleteTarget(): Promise<string> {
  const result = await deleteMenuItem(bistro, target);
  expect(result).toMatchObject({ ok: true });
  return String((result as { entryId: number }).entryId);
}

describe("re-seed race with room on the home page", () => {
  it("control: without a race the restore puts the highlight back (the `written` guard matches the dish it wrote)", async () => {
    const entry = await deleteTarget();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: true, photoLost: expect.any(Boolean), featured: true });
    expect(await highlightsOf(target)).toBe(1);
    expect(await restoredRows(target)).toBe(1);
  });

  it("re-seed WITH the highlight: no throw (no primary-key clash), already-back, one highlight, no 'restored' row", async () => {
    const entry = await deleteTarget();
    expect(await restoreMenuItem(reseedBeforeBatch(target, categoryId, true), entry)).toEqual({ ok: false, error: "already-back" });
    expect(await highlightsOf(target)).toBe(1);
    expect(await restoredRows(target)).toBe(0);
    expect(await getMenuItem(bistro, target)).toMatchObject({ name: { sv: "Omseedad" }, rowVersion: 0 });
  });

  it("re-seed WITHOUT the highlight: the restore doesn't feature the re-seeded dish", async () => {
    const entry = await deleteTarget();
    expect(await restoreMenuItem(reseedBeforeBatch(target, categoryId, false), entry)).toEqual({ ok: false, error: "already-back" });
    expect(await highlightsOf(target)).toBe(0);
    expect(await restoredRows(target)).toBe(0);
  });
});
