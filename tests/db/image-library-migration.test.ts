/**
 * M6.3 acceptance (ADR-014 §2): migration 0005 applies on top of the previous release's schema
 * *with data*, and the live sites keep rendering between the deploy and the operator's re-seed.
 * "Rendering" here is what the D1 content source does before every page: read the site with
 * exportSite and validate it with the content schema.
 *
 * The database is cleared and rebuilt to the previous release (migrations up to 0004), loaded
 * the way that release's seed wrote it (curated images without alt, a highlight with its own
 * photo, gallery rows carrying the alt), and only then migrated to 0005.
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

/** The images insert as the previous release's seed wrote it: no alt, no size. */
function asPreviousRelease(statements: Statement[]): Statement[] {
  return statements.map((s) =>
    s.sql.startsWith("INSERT INTO images ")
      ? { sql: "INSERT INTO images (site_id, id, kind, path, mime) VALUES (?, ?, 'static', ?, ?)", params: s.params.slice(0, 4) }
      : s,
  );
}

const migration = (name: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(name))!;

beforeAll(async () => {
  for (const { ref } of content.images) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref));
    hashes.set(ref, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  // Back to an empty database (children before parents: newest table first), then the previous release's schema.
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC").all<{ name: string }>();
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = true"), ...tables.results.map((t) => db.prepare(`DROP TABLE "${t.name}"`))]);
  for (const name of ["0001", "0002", "0003", "0004"]) await db.batch(migration(name).queries.map((q) => db.prepare(q)));

  // The previous release's data: curated rows without alt, and the first highlight with a photo.
  await db.batch(prepare(db, asPreviousRelease(seedStatements(SITE, content as StoredContent, fakeImages))));
  const anyImage = hashes.get(content.images[0].ref)!;
  await db.prepare("UPDATE home_highlights SET image_id = ? WHERE site_id = ? AND position = 0").bind(anyImage, SITE).run();

  await db.batch(migration("0005").queries.map((q) => db.prepare(q)));
});

describe("migration 0005 on the previous release's data", () => {
  it("adds the alt and row_version columns, leaving the old rows' alt empty until the re-seed", async () => {
    const row = await db.prepare("SELECT alt_sv, alt_en, row_version FROM images WHERE site_id = ? LIMIT 1").bind(SITE).first();
    expect(row).toEqual({ alt_sv: null, alt_en: null, row_version: 0 });
  });

  it("clears the per-highlight photos", async () => {
    const { n } = (await db.prepare("SELECT count(*) AS n FROM home_highlights WHERE image_id IS NOT NULL").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("the site still reads as valid content, so the live pages keep rendering before the re-seed", async () => {
    const exported = (await exportSite(db, SITE))!;
    const checked = siteContentSchema(SITE).safeParse({ ...exported.content, theme });
    expect(checked.success, JSON.stringify(checked.error?.issues.slice(0, 3))).toBe(true);
  });

  it("the gallery keeps its alt text from the gallery rows until the re-seed moves it to the library", async () => {
    const exported = (await exportSite(db, SITE))!;
    const library = new Map(exported.content.images.map((i) => [i.ref, i.alt]));
    for (const [index, g] of exported.content.gallery.images.entries()) {
      expect(library.get(g.image), `gallery photo ${index}`).toEqual(content.images.find((i) => i.ref === g.image)!.alt);
    }
  });

  it("refuses an alt that is only spaces, and accepts one alt being set later", async () => {
    const id = hashes.get(content.images[0].ref)!;
    await expect(db.prepare("UPDATE images SET alt_sv = ' ' WHERE site_id = ? AND id = ?").bind(SITE, id).run()).rejects.toThrow(/CHECK/);
    await db.prepare("UPDATE images SET alt_sv = 'Kafébar', alt_en = 'Café bar' WHERE site_id = ? AND id = ?").bind(SITE, id).run();
    expect(await db.prepare("SELECT alt_sv FROM images WHERE site_id = ? AND id = ?").bind(SITE, id).first("alt_sv")).toBe("Kafébar");
  });
});
