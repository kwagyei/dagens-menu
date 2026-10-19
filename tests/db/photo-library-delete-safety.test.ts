/**
 * Tester, M6.10a photo library (ADR-014 §4, §6): delete safety for every use type, the races
 * between a confirmation and a delete, cross-site isolation with the same image id on both
 * sites, malformed ids, audit rows and content_version bumps exactly when something changed.
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
import { exportSite } from "../../src/db/export";
import { deleteImage, deleteUnusedImages, getLibraryImage, listLibrary, PAGE_SLOTS, updateImageAlt } from "../../src/db/library";
import { addUpload, type Upload } from "../../src/db/photos";
import type { RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const NOW = new Date("2026-10-17T12:00:00Z");
const ctx = (siteId: string, userId: string | null = "owner1"): RepoContext => ({ db, siteId, userId, now: NOW });
const bistro = ctx("bistro");
const wa = ctx("westafrican");
const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
const hashes = new Map<string, string>();
const images: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const DISH = menu.categories[0].items[0].id;

let counter = 0;
function upload(id?: string): Upload {
  ++counter;
  return {
    id: id ?? (0xb000 + counter).toString(16).padStart(64, "c"),
    variants: [
      { width: 400, height: 300, bytes: crypto.getRandomValues(new Uint8Array(300)) },
      { width: 800, height: 600, bytes: crypto.getRandomValues(new Uint8Array(600)) },
    ],
    alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` },
  };
}
async function uploaded(site = "bistro", id?: string): Promise<string> {
  const u = upload(id);
  expect(await addUpload(ctx(site), u)).toMatchObject({ ok: true });
  return u.id;
}
const n = async (sql: string, ...params: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...params)
    .first<{ n: number }>())!.n;
const version = (site = "bistro") => db.prepare("SELECT content_version AS v FROM sites WHERE id = ?").bind(site).first<number>("v");
const variants = (site: string, id: string) => n("SELECT count(*) AS n FROM image_variants WHERE site_id = ? AND image_id = ?", site, id);
const exists = (site: string, id: string) => n("SELECT count(*) AS n FROM images WHERE site_id = ? AND id = ?", site, id);
const audits = () => n("SELECT count(*) AS n FROM audit_log WHERE entity = 'image'");

/** A minimal page_content row for westafrican, so its slots can point at its own images. */
async function westafricanPageRow() {
  const row = await db.prepare("SELECT * FROM page_content WHERE site_id = 'bistro'").first<Record<string, unknown>>();
  const cols = Object.keys(row!).filter((c) => !c.endsWith("_image_id"));
  await db
    .prepare(
      `INSERT INTO page_content (${cols.join(", ")}) SELECT ${cols.map((c) => (c === "site_id" ? "'westafrican'" : c)).join(", ")} FROM page_content WHERE site_id = 'bistro'`,
    )
    .run();
}

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

describe("delete safety: every use type keeps the photo", () => {
  for (const slot of PAGE_SLOTS) {
    it(`page slot ${slot}: deleteImage refuses, deleteUnusedImages keeps it, variants stay`, async () => {
      const id = await uploaded();
      await db.prepare(`UPDATE page_content SET ${slot}_image_id = ? WHERE site_id = 'bistro'`).bind(id).run();
      const v = await version();
      const a = await audits();
      expect(await deleteImage(bistro, id)).toEqual({ ok: false, error: "in-use", uses: [{ kind: "page", slot }] });
      expect(await deleteUnusedImages(bistro)).toEqual({ deleted: 0 });
      expect(await exists("bistro", id)).toBe(1);
      expect(await variants("bistro", id)).toBe(2);
      expect(await version()).toBe(v);
      expect(await audits()).toBe(a);
    });
  }

  it("dish and gallery uses are kept by deleteUnusedImages too", async () => {
    const onDish = await uploaded();
    const inGallery = await uploaded();
    const free = await uploaded();
    await db.prepare("UPDATE menu_items SET image_id = ? WHERE site_id = 'bistro' AND id = ?").bind(onDish, DISH).run();
    await db
      .prepare("UPDATE gallery_images SET image_id = ? WHERE site_id = 'bistro' AND position = (SELECT max(position) FROM gallery_images WHERE site_id = 'bistro')")
      .bind(inGallery)
      .run();
    expect(await deleteUnusedImages(bistro)).toEqual({ deleted: 1 });
    expect(await exists("bistro", onDish)).toBe(1);
    expect(await exists("bistro", inGallery)).toBe(1);
    expect(await exists("bistro", free)).toBe(0);
    expect(await variants("bistro", free)).toBe(0);
  });

  it("an unavailable (hidden) dish still counts as a use", async () => {
    const id = await uploaded();
    await db.prepare("UPDATE menu_items SET image_id = ?, available = 0 WHERE site_id = 'bistro' AND id = ?").bind(id, DISH).run();
    expect(await deleteImage(bistro, id)).toMatchObject({ ok: false, error: "in-use" });
  });
});

describe("races between the confirmation and the POST", () => {
  it("a gallery use added after the confirmation page: deleteImage answers in-use with the place", async () => {
    const id = await uploaded();
    expect((await getLibraryImage(bistro, id))!.uses).toEqual([]); // what the confirm page saw
    await db.prepare("UPDATE gallery_images SET image_id = ? WHERE site_id = 'bistro' AND position = 0").bind(id).run();
    const result = await deleteImage(bistro, id);
    expect(result).toMatchObject({ ok: false, error: "in-use" });
    expect(await variants("bistro", id)).toBe(2);
  });

  it("concurrent delete and assignment never leave a dangling reference", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await uploaded();
      const assign = db
        .prepare("UPDATE menu_items SET image_id = ? WHERE site_id = 'bistro' AND id = ?")
        .bind(id, DISH)
        .run()
        .then(
          () => "assigned",
          () => "assign-failed",
        );
      const del = deleteImage(bistro, id);
      const [a, d] = await Promise.all([assign, del]);
      const stillThere = await exists("bistro", id);
      const dish = await db.prepare("SELECT image_id FROM menu_items WHERE site_id = 'bistro' AND id = ?").bind(DISH).first<string | null>("image_id");
      if (d.ok) {
        expect(stillThere).toBe(0);
        expect(a).toBe("assign-failed");
        expect(dish).not.toBe(id);
      } else {
        expect(stillThere).toBe(1);
        expect(dish).toBe(id);
      }
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      await db.prepare("UPDATE menu_items SET image_id = NULL WHERE site_id = 'bistro' AND id = ?").bind(DISH).run();
    }
  });

  it("deleteUnusedImages while a photo is being assigned: the assigned one survives", async () => {
    const a = await uploaded();
    const b = await uploaded();
    const assign = db
      .prepare("UPDATE page_content SET story_image_id = ? WHERE site_id = 'bistro'")
      .bind(a)
      .run()
      .then(
        () => "assigned",
        () => "assign-failed",
      );
    const [assigned, result] = await Promise.all([assign, deleteUnusedImages(bistro)]);
    const story = await db.prepare("SELECT story_image_id AS s FROM page_content WHERE site_id = 'bistro'").first<string | null>("s");
    if (assigned === "assigned" && story === a) expect(await exists("bistro", a)).toBe(1);
    expect(await exists("bistro", b)).toBe(0);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});

describe("audit rows and content_version", () => {
  it("deleteImage: one audit row with user, time, id and alt; content_version moves", async () => {
    const id = await uploaded();
    const v = (await version())!;
    const before = await audits();
    expect(await deleteImage(bistro, id)).toEqual({ ok: true });
    expect(await version()).toBeGreaterThan(v);
    expect(await audits()).toBe(before + 1);
    const row = await db.prepare("SELECT * FROM audit_log WHERE entity = 'image' AND action = 'delete' ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
    expect(row).toMatchObject({ site_id: "bistro", user_id: "owner1", entity_id: id, at: "2026-10-17T12:00:00Z" });
    expect(row!.summary).toMatch(/^Foto \d+: deleted$/);
  });

  it("deleting twice: the second answers not-found and writes nothing", async () => {
    const id = await uploaded();
    await deleteImage(bistro, id);
    const v = await version();
    const a = await audits();
    expect(await deleteImage(bistro, id)).toEqual({ ok: false, error: "not-found" });
    expect(await version()).toBe(v);
    expect(await audits()).toBe(a);
  });

  it("deleteUnusedImages: one audit row naming the count, and the count equals what went", async () => {
    for (let i = 0; i < 3; i++) await uploaded();
    const total = await n("SELECT count(*) AS n FROM images WHERE site_id = 'bistro'");
    const v = (await version())!;
    expect(await deleteUnusedImages(bistro)).toEqual({ deleted: 3 });
    expect(await n("SELECT count(*) AS n FROM images WHERE site_id = 'bistro'")).toBe(total - 3);
    expect(await version()).toBeGreaterThan(v);
    const rows = (await db.prepare("SELECT * FROM audit_log WHERE entity = 'image' AND action = 'delete'").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site_id: "bistro", user_id: "owner1", entity_id: null, summary: "Deleted 3 unused photo(s)" });
    // Built-in photos all survive.
    expect(await n("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'static'")).toBe(content.images.length);
  });

  it("a stale alt edit writes nothing: no audit row, no version bump", async () => {
    const id = await uploaded();
    const v = await version();
    const a = await audits();
    expect(await updateImageAlt(bistro, id, 99, { sv: "x", en: "y" })).toMatchObject({ ok: false, error: "conflict", current: 0 });
    expect(await version()).toBe(v);
    expect(await audits()).toBe(a);
  });

  it("an alt edit on a gallery photo reaches the exported (public) content", async () => {
    const ref = gallery.images[0].image;
    const id = hashes.get(ref)!;
    const img = (await getLibraryImage(bistro, id))!;
    expect(await updateImageAlt(bistro, id, img.rowVersion, { sv: "Ny beskrivning", en: "New description" })).toEqual({ ok: true });
    const exported = await exportSite(db, "bistro");
    const found = (exported!.content.images as Array<{ ref: string; alt?: { sv: string; en: string } }>).find((i) => i.ref === ref);
    expect(found?.alt).toEqual({ sv: "Ny beskrivning", en: "New description" });
  });
});

describe("cross-site: the same image id on both sites", () => {
  const SHARED = "d".repeat(64);

  it("bistro deleting its copy leaves westafrican's row and variants, even when westafrican uses it", async () => {
    await uploaded("bistro", SHARED);
    await uploaded("westafrican", SHARED);
    await westafricanPageRow();
    await db.prepare("UPDATE page_content SET kitchen_image_id = ? WHERE site_id = 'westafrican'").bind(SHARED).run();
    // westafrican's use is not a bistro use.
    expect((await getLibraryImage(bistro, SHARED))!.uses).toEqual([]);
    const vWa = await version("westafrican");
    expect(await deleteImage(bistro, SHARED)).toEqual({ ok: true });
    expect(await exists("bistro", SHARED)).toBe(0);
    expect(await exists("westafrican", SHARED)).toBe(1);
    expect(await variants("westafrican", SHARED)).toBe(2);
    expect(await version("westafrican")).toBe(vWa);
  });

  it("bistro's deleteUnusedImages never touches westafrican's unused uploads", async () => {
    const theirs = await uploaded("westafrican");
    await uploaded("bistro");
    expect(await deleteUnusedImages(bistro)).toEqual({ deleted: 1 });
    expect(await exists("westafrican", theirs)).toBe(1);
    expect(await variants("westafrican", theirs)).toBe(2);
  });

  it("bistro's alt edit of a westafrican-only id is not-found and leaves it alone", async () => {
    const theirs = await uploaded("westafrican");
    expect(await updateImageAlt(bistro, theirs, 0, { sv: "hack", en: "hack" })).toEqual({ ok: false, error: "not-found" });
    const row = await db.prepare("SELECT alt_sv, row_version FROM images WHERE site_id = 'westafrican' AND id = ?").bind(theirs).first();
    expect(row).toMatchObject({ row_version: 0 });
    expect(row!.alt_sv).not.toBe("hack");
    expect((await listLibrary(wa)).find((i) => i.id === theirs)).toBeDefined();
  });
});

describe("malformed ids", () => {
  const real = "e".repeat(64);
  const bad = ["", "..", "%2e", "%2e%2e", "../" + real, real.toUpperCase(), real + "e", "e".repeat(10_000), "%", "_", "' OR 1=1 --", real.slice(0, 12), "abc\u0000def"];
  for (const id of bad) {
    it(`${JSON.stringify(id.length > 70 ? `${id.slice(0, 10)}…(${id.length})` : id)}: not found everywhere, nothing written`, async () => {
      await uploaded("bistro", real);
      const v = await version();
      const a = await audits();
      expect(await getLibraryImage(bistro, id)).toBeNull();
      expect(await deleteImage(bistro, id)).toEqual({ ok: false, error: "not-found" });
      expect(await updateImageAlt(bistro, id, 0, { sv: "x", en: "y" })).toEqual({ ok: false, error: "not-found" });
      expect(await exists("bistro", real)).toBe(1);
      expect(await version()).toBe(v);
      expect(await audits()).toBe(a);
    });
  }
});
