/**
 * The database after 0006, from empty. Raw writes that try to get an image
 * without alt past the triggers, and the rebuilt home_highlights keeping its rules.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const IMG = "a".repeat(64);
const OTHER = "c".repeat(64);
const ITEM = "item00000001";
const CAT = "cat000000001";
const REFUSED = /alt text in Swedish and English/;

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro')"),
    db
      .prepare("INSERT INTO images (site_id, id, kind, path, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'static', '/images/bistro/a.jpg', 'image/jpeg', 'Foto', 'Photo')")
      .bind(IMG),
    db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('bistro', ?, 'mains', 'Varmrätter', 'Mains', 0)").bind(CAT),
    db
      .prepare(
        `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position)
       VALUES ('bistro', ?, ?, 'Soppa', 'Soup', 'Varm', 'Hot', 14500, 0)`,
      )
      .bind(ITEM, CAT),
  ]);
});

const version = () => db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<number>("v");
const alt = () => db.prepare("SELECT alt_sv, alt_en FROM images WHERE site_id = 'bistro' AND id = ?").bind(IMG).first();

describe("an image without alt is refused on every write path", () => {
  it("INSERT OR IGNORE does not swallow the refusal", async () => {
    await expect(db.prepare("INSERT OR IGNORE INTO images (site_id, id, kind, mime) VALUES ('bistro', ?, 'upload', 'image/webp')").bind(OTHER).run()).rejects.toThrow(REFUSED);
  });

  it("INSERT OR REPLACE over an existing image cannot clear its alt", async () => {
    await expect(
      db.prepare("INSERT OR REPLACE INTO images (site_id, id, kind, path, mime) VALUES ('bistro', ?, 'static', '/images/bistro/a.jpg', 'image/jpeg')").bind(IMG).run(),
    ).rejects.toThrow(REFUSED);
    expect(await alt()).toEqual({ alt_sv: "Foto", alt_en: "Photo" });
  });

  it("an upsert that sets alt to NULL is refused", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO images (site_id, id, kind, path, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'static', '/images/bistro/a.jpg', 'image/jpeg', 'X', 'X') ON CONFLICT DO UPDATE SET alt_en = NULL",
        )
        .bind(IMG)
        .run(),
    ).rejects.toThrow(REFUSED);
    expect(await alt()).toEqual({ alt_sv: "Foto", alt_en: "Photo" });
  });

  it("clearing only the English alt is refused", async () => {
    await expect(db.prepare("UPDATE images SET alt_en = NULL WHERE id = ?").bind(IMG).run()).rejects.toThrow(REFUSED);
  });

  it("an empty alt is refused by the CHECK from 0005", async () => {
    await expect(db.prepare("UPDATE images SET alt_sv = '' WHERE id = ?").bind(IMG).run()).rejects.toThrow(/CHECK/);
  });

  it("writes that don't touch alt still work on an image with alt", async () => {
    await db.prepare("UPDATE images SET width = 800, height = 600, row_version = row_version + 1 WHERE id = ?").bind(IMG).run();
    await db.prepare("UPDATE images SET alt_sv = alt_sv WHERE id = ?").bind(IMG).run();
    expect(await alt()).toEqual({ alt_sv: "Foto", alt_en: "Photo" });
  });

  it("a refused statement inside a batch rolls the whole batch back", async () => {
    await expect(
      db.batch([
        db.prepare("UPDATE images SET alt_sv = 'Ny' WHERE id = ?").bind(IMG),
        db.prepare("INSERT INTO images (site_id, id, kind, mime) VALUES ('bistro', ?, 'upload', 'image/webp')").bind(OTHER),
      ]),
    ).rejects.toThrow(REFUSED);
    expect(await alt()).toEqual({ alt_sv: "Foto", alt_en: "Photo" });
  });
});

describe("gallery_images after 0006", () => {
  it("has no alt columns, and a write naming them fails", async () => {
    const cols = (await db.prepare("SELECT name FROM pragma_table_info('gallery_images')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(["site_id", "id", "image_id", "position"]);
    await expect(
      db.prepare("INSERT INTO gallery_images (site_id, id, image_id, alt_sv, alt_en, position) VALUES ('bistro', 'g00000000001', ?, 'a', 'b', 0)").bind(IMG).run(),
    ).rejects.toThrow(/alt_sv/);
  });

  it("still refuses a gallery row for an image that isn't there", async () => {
    await db.exec("PRAGMA foreign_keys = ON");
    await expect(db.prepare("INSERT INTO gallery_images (site_id, id, image_id, position) VALUES ('bistro', 'g00000000001', ?, 0)").bind(OTHER).run()).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("home_highlights after the 0006 rebuild", () => {
  it("is STRICT with the same primary key, position check and dish foreign key", async () => {
    const sql = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'home_highlights'").first<string>("sql");
    expect(sql).toMatch(/STRICT\s*$/);
    await expect(db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, -1)").bind(ITEM).run()).rejects.toThrow(/CHECK/);
    await expect(db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', 'nosuchitem01', 0)").run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 'first')").bind(ITEM).run()).rejects.toThrow(/datatype|cannot store/i);
    await db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 0)").bind(ITEM).run();
    await expect(db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 1)").bind(ITEM).run()).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("moves content_version on insert, update and delete", async () => {
    let v = (await version())!;
    await db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 0)").bind(ITEM).run();
    expect(await version()).toBe(v + 1);
    v++;
    await db.prepare("UPDATE home_highlights SET position = 3 WHERE item_id = ?").bind(ITEM).run();
    expect(await version()).toBe(v + 1);
    v++;
    await db.prepare("DELETE FROM home_highlights WHERE item_id = ?").bind(ITEM).run();
    expect(await version()).toBe(v + 1);
  });

  it("follows a dish delete, and deleting a site clears its highlights", async () => {
    await db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 0)").bind(ITEM).run();
    await db.prepare("DELETE FROM sites WHERE id = 'bistro'").run();
    expect(await db.prepare("SELECT count(*) AS n FROM home_highlights").first<number>("n")).toBe(0);
  });

  it("no longer holds a photo: deleting an image doesn't depend on highlights", async () => {
    await db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 0)").bind(ITEM).run();
    await db.prepare("DELETE FROM images WHERE site_id = 'bistro' AND id = ?").bind(IMG).run();
    expect(await db.prepare("SELECT count(*) AS n FROM home_highlights").first<number>("n")).toBe(1);
    expect((await db.prepare("SELECT * FROM pragma_foreign_key_check").all()).results).toEqual([]);
  });

  it("leaves no stray table or trigger from the rebuild", async () => {
    const stray = await db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%home_highlights_new%' OR sql LIKE '%home_highlights_new%'").all();
    expect(stray.results).toEqual([]);
  });
});
