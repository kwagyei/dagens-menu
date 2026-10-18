/**
 * The photo library in the database (plan M6.10; ADR-014 §4, §6): uses derived from dishes,
 * page photos and the gallery; alt edits guarded on row_version; deleting only an unused
 * upload of this site, with 409-style reasons; "delete all unused" in one transaction.
 */
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import imageLibrary from "../../sites/bistro/content/images.json";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { siteContentSchema } from "../../src/content/schema";
import { deleteImage, deleteUnusedImages, getLibraryImage, listLibrary, updateImageAlt } from "../../src/db/library";
import { addUpload, type Upload } from "../../src/db/photos";
import type { RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const NOW = new Date("2026-10-17T12:00:00Z");
const ctx = (siteId: string, userId: string | null = "owner1"): RepoContext => ({ db, siteId, userId, now: NOW });
const bistro = ctx("bistro");
const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
const hashes = new Map<string, string>();
const images: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const DISH = menu.categories[0].items[0].id;

let counter = 0;
function upload(): Upload {
  const id = (++counter).toString(16).padStart(64, "a");
  return { id, variants: [{ width: 400, height: 300, bytes: crypto.getRandomValues(new Uint8Array(500)) }], alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` } };
}
async function uploaded(site = "bistro"): Promise<string> {
  const u = upload();
  expect(await addUpload(ctx(site), u)).toMatchObject({ ok: true });
  return u.id;
}
const count = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number }>())!.n;
const version = () => db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<number>("v");

beforeAll(async () => {
  for (const path of (content as StoredContent).images.map((i) => i.ref)) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    hashes.set(path, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content as StoredContent, images)));
  await db.prepare("INSERT OR IGNORE INTO sites (id) VALUES ('westafrican')").run();
});

describe("listLibrary", () => {
  it("lists uploads first, then every built-in photo, each with where it is used", async () => {
    const unused = await uploaded();
    const onDish = await uploaded();
    await db.prepare("UPDATE menu_items SET image_id = ? WHERE site_id = 'bistro' AND id = ?").bind(onDish, DISH).run();

    const library = await listLibrary(bistro);
    expect(library.slice(0, 2).map((i) => i.kind)).toEqual(["upload", "upload"]);
    expect(library.filter((i) => i.kind === "static")).toHaveLength(content.images.length);
    expect(library.find((i) => i.id === unused)!.uses).toEqual([]);
    expect(library.find((i) => i.id === onDish)!.uses).toEqual([{ kind: "dish", id: DISH, name: menu.categories[0].items[0].name }]);

    // The seeded page photos and gallery are uses of built-in photos, by slot and position.
    const hero = library.find((i) => i.ref === pages.home.heroImage)!;
    expect(hero.uses).toContainEqual({ kind: "page", slot: "hero" });
    const firstGallery = library.find((i) => i.ref === gallery.images[0].image)!;
    expect(firstGallery.uses).toContainEqual({ kind: "gallery", position: 1 });
    expect(hero.ref).toBe(hero.path);
    expect(library.find((i) => i.id === unused)!.ref).toBe(unused);
  });

  it("never shows another site's photos", async () => {
    const theirs = await uploaded("westafrican");
    expect((await listLibrary(bistro)).some((i) => i.id === theirs)).toBe(false);
    expect(await getLibraryImage(bistro, theirs)).toBeNull();
  });
});

describe("updateImageAlt", () => {
  it("saves both languages, moves row_version and the content version, and audits who did it", async () => {
    const id = await uploaded();
    const before = (await getLibraryImage(bistro, id))!;
    const v = await version();
    expect(await updateImageAlt(bistro, id, before.rowVersion, { sv: "Ny text", en: "New text" })).toEqual({ ok: true });
    const after = (await getLibraryImage(bistro, id))!;
    expect(after.alt).toEqual({ sv: "Ny text", en: "New text" });
    expect(after.rowVersion).toBe(before.rowVersion + 1);
    expect(await version()).toBeGreaterThan(v!);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image' AND entity_id = ? AND action = 'update' AND user_id = 'owner1'", id)).toBe(1);
  });

  it("refuses a stale edit with the current version, and writes nothing", async () => {
    const id = await uploaded();
    await updateImageAlt(bistro, id, 0, { sv: "Först", en: "First" });
    expect(await updateImageAlt(bistro, id, 0, { sv: "Sen", en: "Late" })).toEqual({ ok: false, error: "conflict", current: 1 });
    expect((await getLibraryImage(bistro, id))!.alt).toEqual({ sv: "Först", en: "First" });
  });

  it("edits a built-in photo's alt too", async () => {
    const hero = (await listLibrary(bistro)).find((i) => i.ref === pages.home.heroImage)!;
    expect(await updateImageAlt(bistro, hero.id, hero.rowVersion, { sv: "Hjälte", en: "Hero" })).toEqual({ ok: true });
  });

  it("can't reach another site's photo", async () => {
    const theirs = await uploaded("westafrican");
    expect(await updateImageAlt(bistro, theirs, 0, { sv: "x", en: "x" })).toEqual({ ok: false, error: "not-found" });
    expect((await getLibraryImage(ctx("westafrican"), theirs))!.alt).toEqual({ sv: expect.stringMatching(/^Foto/), en: expect.stringMatching(/^Photo/) });
  });
});

describe("deleteImage", () => {
  it("deletes an unused upload with its sizes, audits it and moves the content version", async () => {
    const id = await uploaded();
    const v = await version();
    expect(await deleteImage(bistro, id)).toEqual({ ok: true });
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM image_variants WHERE image_id = ?", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image' AND entity_id = ? AND action = 'delete'", id)).toBe(1);
    expect(await version()).toBeGreaterThan(v!);
  });

  it("refuses a photo in use and says where: a dish, a page photo, the gallery", async () => {
    const id = await uploaded();
    await db.batch([
      db.prepare("UPDATE menu_items SET image_id = ? WHERE site_id = 'bistro' AND id = ?").bind(id, DISH),
      db.prepare("UPDATE page_content SET story_image_id = ? WHERE site_id = 'bistro'").bind(id),
      db.prepare("INSERT INTO gallery_images (site_id, id, image_id, position) VALUES ('bistro', 'zzzzzzzzzzzz', ?, 99)").bind(id),
    ]);
    const result = await deleteImage(bistro, id);
    expect(result).toMatchObject({ ok: false, error: "in-use" });
    expect(result.ok === false && result.error === "in-use" && result.uses.map((u) => u.kind).sort()).toEqual(["dish", "gallery", "page"]);
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", id)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image' AND action = 'delete'")).toBe(0);
  });

  it("a use added between the check and the delete is caught by the foreign key as in use", async () => {
    const id = await uploaded();
    // A trigger stands in for the race: it adds a gallery use while the delete runs, after
    // the statement's own "nothing uses it" check passed.
    await db
      .prepare(
        `CREATE TRIGGER race_adds_a_use BEFORE DELETE ON images BEGIN
           INSERT INTO gallery_images (site_id, id, image_id, position) VALUES (OLD.site_id, 'racerace0001', OLD.id, 99);
         END`,
      )
      .run();
    try {
      const result = await deleteImage(bistro, id);
      expect(result).toMatchObject({ ok: false, error: "in-use" });
      expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", id)).toBe(1);
      expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image' AND action = 'delete'")).toBe(0);
    } finally {
      await db.prepare("DROP TRIGGER race_adds_a_use").run();
    }
  });

  it("refuses a built-in photo, even an unused one", async () => {
    await db.prepare("UPDATE page_content SET kitchen_image_id = NULL, story_image_id = NULL WHERE site_id = 'bistro'").run();
    const unusedBuiltIn = (await listLibrary(bistro)).find((i) => i.kind === "static" && i.uses.length === 0)!;
    expect(unusedBuiltIn).toBeDefined();
    expect(await deleteImage(bistro, unusedBuiltIn.id)).toEqual({ ok: false, error: "built-in" });
  });

  it("answers not-found for an unknown id, a malformed one, and another site's photo", async () => {
    const theirs = await uploaded("westafrican");
    expect(await deleteImage(bistro, "f".repeat(64))).toEqual({ ok: false, error: "not-found" });
    expect(await deleteImage(bistro, "../x")).toEqual({ ok: false, error: "not-found" });
    expect(await deleteImage(bistro, theirs)).toEqual({ ok: false, error: "not-found" });
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", theirs)).toBe(1);
  });
});

describe("deleteUnusedImages", () => {
  it("deletes every unused upload in one go, keeps used and built-in photos, and audits the count once", async () => {
    const a = await uploaded();
    const b = await uploaded();
    const used = await uploaded();
    await db.prepare("UPDATE menu_items SET image_id = ? WHERE site_id = 'bistro' AND id = ?").bind(used, DISH).run();
    const theirs = await uploaded("westafrican");
    const builtIn = await count("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'static'");

    expect(await deleteUnusedImages(bistro)).toEqual({ deleted: 2 });
    for (const id of [a, b]) expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", used)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", theirs)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'static'")).toBe(builtIn);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image' AND action = 'delete' AND summary = 'Deleted 2 unused photo(s)' AND user_id = 'owner1'")).toBe(1);
  });

  it("with nothing unused: deletes nothing and writes no audit row", async () => {
    expect(await deleteUnusedImages(bistro)).toEqual({ deleted: 0 });
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image' AND action = 'delete'")).toBe(0);
  });
});
