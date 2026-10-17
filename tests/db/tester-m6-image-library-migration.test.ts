/**
 * Tester, M6.3 (ADR-014 §2): cases image-library-migration.test.ts doesn't cover. The previous
 * release's data, then 0005, then what the live site reads before the operator's re-seed:
 * - the same image twice in the gallery, with a different alt on each row
 * - an image used by a dish only (no gallery row, so no alt anywhere)
 * - an image used only as a highlight photo (orphaned by 0005)
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
import { exportFile, readExportFile } from "../../src/db/export-file";
import { type ImageResolver, resetStatements, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare, type Statement } from "../../src/db/sql";

const db = env.DB;
const SITE = "bistro";
const raw = { settings, hours, menu, pages, gallery: structuredClone(gallery), images: imageLibrary, theme };
// The previous release's gallery: the first photo appears twice.
raw.gallery.images.push({ ...raw.gallery.images[0] });
const { theme: _t, ...content } = siteContentSchema(SITE).parse(raw);

const hashes = new Map<string, string>();
const fakeImages: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const asPreviousRelease = (statements: Statement[]): Statement[] =>
  statements.map((s) =>
    s.sql.startsWith("INSERT INTO images ")
      ? { sql: "INSERT INTO images (site_id, id, kind, path, mime) VALUES (?, ?, 'static', ?, ?)", params: s.params.slice(0, 4) }
      : s,
  );
const migration = (name: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(name))!;
const galleryRefs = new Set(content.gallery.images.map((g) => g.image));
const dishOnly = content.menu.categories.flatMap((c) => c.items).find((i) => i.image && !galleryRefs.has(i.image))?.image;
const DUP = content.gallery.images[0].image;
const lastIndex = content.gallery.images.length - 1;

beforeAll(async () => {
  for (const { ref } of content.images) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref));
    hashes.set(ref, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC").all<{ name: string }>();
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = true"), ...tables.results.map((t) => db.prepare(`DROP TABLE "${t.name}"`))]);
  for (const name of ["0001", "0002", "0003", "0004"]) await db.batch(migration(name).queries.map((q) => db.prepare(q)));
  await db.batch(prepare(db, asPreviousRelease(seedStatements(SITE, content as StoredContent, fakeImages))));
  // The duplicate gallery row had its own alt in the previous release.
  await db.prepare("UPDATE gallery_images SET alt_sv = 'Andra texten', alt_en = 'Second text' WHERE site_id = ? AND position = ?").bind(SITE, lastIndex).run();
  await db.batch(migration("0005").queries.map((q) => db.prepare(q)));
});

describe("0005 on previous-release data the main migration test doesn't build", () => {
  it("the fixture has a dish photo that isn't in the gallery", () => {
    expect(dishOnly).toBeDefined();
  });

  it("the site still validates, so the live pages keep rendering", async () => {
    const exported = (await exportSite(db, SITE))!;
    const checked = siteContentSchema(SITE).safeParse({ ...exported.content, theme });
    expect(checked.success, JSON.stringify(checked.error?.issues.slice(0, 3))).toBe(true);
  });

  it("a dish-only photo is listed in the library without alt (allowed until the contract)", async () => {
    const exported = (await exportSite(db, SITE))!;
    expect(exported.content.images.find((i) => i.ref === dishOnly)).toEqual({ ref: dishOnly });
  });

  it("each gallery row keeps the alt it had before the migration (same photo twice, two alts)", async () => {
    const exported = (await exportSite(db, SITE))!;
    const alt = exported.content.images.find((i) => i.ref === DUP)?.alt;
    // The library model holds one alt per image; position 0 had the original alt.
    expect.soft(alt, "position 0's alt was replaced by the duplicate row's").toEqual(content.images.find((i) => i.ref === DUP)!.alt);
  });

  it("an export taken before the re-seed restores (seed → export → read → seed)", async () => {
    const exported = (await exportSite(db, SITE))!;
    const text = JSON.stringify(exportFile(SITE, exported, new Date("2026-10-17T10:00:00Z")));
    const read = readExportFile(text, SITE, { theme: theme as never, settings: settings as never, images: content.images });
    if (!read.ok) throw new Error(read.error);
    await db.batch(prepare(db, [...resetStatements(SITE), ...seedStatements(SITE, read.content, fakeImages)]));
    const again = (await exportSite(db, SITE))!;
    expect(again.content.gallery).toEqual(exported.content.gallery);
  });
});
