/**
 * The image library's two migrations on production's path (ADR-014 §2): the release before
 * M6 with data, then 0005 (expand), the operator's re-seed, then 0006 (contract).
 *
 * The database is cleared and rebuilt to the release before M6 (migrations up to 0004), loaded
 * the way that release's seed wrote it: curated images without alt, gallery rows carrying the
 * alt, a highlight with its own photo. Today's seed can't write that shape any more, so its
 * statements are rewritten into it.
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
import { exportSite } from "../../src/db/export";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare, type Statement } from "../../src/db/sql";

const db = env.DB;
const SITE = "bistro";
const { theme: _t, ...content } = siteContentSchema(SITE).parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });

const hashes = new Map<string, string>();
const fakeImages: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const altOfId = () => new Map(content.images.map((i) => [hashes.get(i.ref)!, i.alt]));

/** Today's seed, rewritten the way the release before M6 wrote it. */
function asReleaseBeforeM6(statements: Statement[]): Statement[] {
  const alts = altOfId();
  return statements.map((s) => {
    if (s.sql.startsWith("INSERT INTO images ")) {
      return { sql: "INSERT INTO images (site_id, id, kind, path, mime) VALUES (?, ?, 'static', ?, ?)", params: s.params.slice(0, 4) };
    }
    if (s.sql.startsWith("INSERT INTO gallery_images ")) {
      const [site, id, imageId, position] = s.params;
      const alt = alts.get(imageId as string)!;
      return { sql: "INSERT INTO gallery_images (site_id, id, image_id, alt_sv, alt_en, position) VALUES (?, ?, ?, ?, ?, ?)", params: [site, id, imageId, alt.sv, alt.en, position] };
    }
    return s;
  });
}

const migration = (name: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(name))!;
const apply = (name: string) => db.batch(migration(name).queries.map((q) => db.prepare(q)));
const columns = async (table: string) => (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);
const count = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number }>())!.n;
const version = () => db.prepare("SELECT content_version AS v FROM sites WHERE id = ?").bind(SITE).first<number>("v");

/** What the operator's re-seed did between the two migrations: every image gets its alt. */
async function reseedAlts() {
  await db.batch([...altOfId()].map(([id, alt]) => db.prepare("UPDATE images SET alt_sv = ?, alt_en = ? WHERE site_id = ? AND id = ?").bind(alt.sv, alt.en, SITE, id)));
}

let before: { gallery: unknown[]; highlights: unknown[]; version: number | null };

beforeAll(async () => {
  for (const { ref } of content.images) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref));
    hashes.set(ref, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  // Back to an empty database (children before parents: newest table first), then the release before M6.
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC").all<{ name: string }>();
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = true"), ...tables.results.map((t) => db.prepare(`DROP TABLE "${t.name}"`))]);
  for (const name of ["0001", "0002", "0003", "0004"]) await apply(name);

  await db.batch(prepare(db, asReleaseBeforeM6(seedStatements(SITE, content as StoredContent, fakeImages))));
  const anyImage = hashes.get(content.images[0].ref)!;
  await db.prepare("UPDATE home_highlights SET image_id = ? WHERE site_id = ? AND position = 0").bind(anyImage, SITE).run();

  await apply("0005");
});

describe("0005 on the data of the release before M6", () => {
  it("adds the alt and row_version columns, leaving the old rows' alt empty until the re-seed", async () => {
    const row = await db.prepare("SELECT alt_sv, alt_en, row_version FROM images WHERE site_id = ? LIMIT 1").bind(SITE).first();
    expect(row).toEqual({ alt_sv: null, alt_en: null, row_version: 0 });
  });

  it("clears the per-highlight photos", async () => {
    expect(await count("SELECT count(*) AS n FROM home_highlights WHERE image_id IS NOT NULL")).toBe(0);
  });

  it("refuses an alt that is only spaces", async () => {
    const id = hashes.get(content.images[0].ref)!;
    await expect(db.prepare("UPDATE images SET alt_sv = ' ' WHERE site_id = ? AND id = ?").bind(SITE, id).run()).rejects.toThrow(/CHECK/);
  });
});

describe("0006 before the re-seed", () => {
  it("aborts as a whole while any image lacks alt, and leaves the schema as it was", async () => {
    await expect(apply("0006")).rejects.toThrow(/alt text in Swedish and English/);
    expect(await columns("gallery_images")).toContain("alt_sv");
    expect(await columns("home_highlights")).toContain("image_id");
    expect(await count("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'images_alt_required%'")).toBe(0);
  });

  it("also aborts when only one image, of one language, is missing", async () => {
    await reseedAlts();
    await db.prepare("UPDATE images SET alt_en = NULL WHERE site_id = ? AND id = ?").bind(SITE, hashes.get(content.images.at(-1)!.ref)).run();
    await expect(apply("0006")).rejects.toThrow(/alt text in Swedish and English/);
    expect(await columns("gallery_images")).toContain("alt_sv");
  });
});

describe("0006 after the re-seed", () => {
  beforeAll(async () => {
    await reseedAlts();
    before = {
      gallery: (await db.prepare("SELECT id, image_id, position FROM gallery_images ORDER BY id").all()).results,
      highlights: (await db.prepare("SELECT site_id, item_id, position FROM home_highlights ORDER BY item_id").all()).results,
      version: await version(),
    };
    await apply("0006");
  });

  it("keeps every gallery row and highlight, and doesn't move content_version", async () => {
    expect((await db.prepare("SELECT id, image_id, position FROM gallery_images ORDER BY id").all()).results).toEqual(before.gallery);
    expect((await db.prepare("SELECT site_id, item_id, position FROM home_highlights ORDER BY item_id").all()).results).toEqual(before.highlights);
    expect(before.highlights.length).toBeGreaterThan(0);
    expect(await version()).toBe(before.version);
  });

  it("drops the gallery's copy of the alt and the highlight's photo", async () => {
    expect(await columns("gallery_images")).not.toContain("alt_sv");
    expect(await columns("gallery_images")).not.toContain("alt_en");
    expect(await columns("home_highlights")).toEqual(["site_id", "item_id", "position"]);
  });

  it("leaves no broken foreign key", async () => {
    expect((await db.prepare("SELECT * FROM pragma_foreign_key_check").all()).results).toEqual([]);
  });

  it("recreates the highlight triggers: deleting a dish removes its highlight and moves content_version", async () => {
    const triggers = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'home_highlights' ORDER BY name").all<{ name: string }>()).results;
    expect(triggers.map((t) => t.name)).toEqual(["home_highlights_delete_bumps_version", "home_highlights_insert_bumps_version", "home_highlights_update_bumps_version"]);
    const item = content.pages.home.highlights[0];
    const v = await version();
    await db.prepare("DELETE FROM menu_items WHERE site_id = ? AND id = ?").bind(SITE, item).run();
    expect(await count("SELECT count(*) AS n FROM home_highlights WHERE site_id = ? AND item_id = ?", SITE, item)).toBe(0);
    expect(await version()).toBeGreaterThan(v!);
  });

  it("refuses an image without alt, on insert and on update", async () => {
    const insert = (alt_sv: string | null, alt_en: string | null) =>
      db
        .prepare("INSERT INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES (?, ?, 'upload', 'image/webp', ?, ?)")
        .bind(SITE, "e".repeat(64), alt_sv, alt_en)
        .run();
    await expect(insert(null, null)).rejects.toThrow(/alt text in Swedish and English/);
    await expect(insert("Foto", null)).rejects.toThrow(/alt text in Swedish and English/);
    const id = hashes.get(content.images[0].ref)!;
    await expect(db.prepare("UPDATE images SET alt_sv = NULL WHERE site_id = ? AND id = ?").bind(SITE, id).run()).rejects.toThrow(/alt text in Swedish and English/);
  });

  it("the site reads as valid content, so the live pages render", async () => {
    const exported = (await exportSite(db, SITE))!;
    const checked = siteContentSchema(SITE).safeParse({ ...exported.content, theme });
    expect(checked.success, JSON.stringify(checked.error?.issues.slice(0, 3))).toBe(true);
    for (const g of exported.content.gallery.images) {
      expect(exported.content.images.find((i) => i.ref === g.image)?.alt).toEqual(content.images.find((i) => i.ref === g.image)!.alt);
    }
  });
});
