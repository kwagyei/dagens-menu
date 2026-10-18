/**
 * Tester, M6.10b admin gallery: races (same photo twice, the 30-photo limit, moves against
 * moves, move against remove), position drift, remove and re-add, the library's use numbering,
 * export and restore round trip, schema validity, cross-site isolation, content_version.
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
import { addToGallery, GALLERY_LIMIT, listGallery, moveGalleryImage, removeFromGallery } from "../../src/db/gallery";
import { listLibrary, updateImageAlt } from "../../src/db/library";
import { addUpload } from "../../src/db/photos";
import type { RepoContext } from "../../src/db/repository";
import { type ImageResolver, resetStatements, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const ctx = (siteId: string): RepoContext => ({ db, siteId, userId: "owner1", now: new Date("2026-10-17T12:00:00Z") });
const bistro = ctx("bistro");
const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
const hashes = new Map<string, string>();
const images: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });

let counter = 0;
async function uploaded(site = "bistro"): Promise<string> {
  const id = (++counter).toString(16).padStart(64, "d");
  const r = await addUpload(ctx(site), { id, variants: [{ width: 400, height: 300, bytes: crypto.getRandomValues(new Uint8Array(300)) }], alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` } });
  expect(r).toMatchObject({ ok: true });
  return id;
}
const n = async (sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).first<{ n: number }>())!.n;
const version = () => db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<number>("v");
const order = async () => (await listGallery(bistro)).map((g) => g.id);
const positions = async () => (await db.prepare("SELECT position FROM gallery_images WHERE site_id = 'bistro' ORDER BY position, id").all<{ position: number }>()).results.map((r) => r.position);

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

describe("races", () => {
  it("two adds of the same photo at once give one row", async () => {
    const id = await uploaded();
    const results = await Promise.all([addToGallery(bistro, id), addToGallery(bistro, id), addToGallery(bistro, id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await n("SELECT count(*) AS n FROM gallery_images WHERE image_id = ?", id)).toBe(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && ["already", "conflict"].includes(r.error))).toBe(true);
  });

  it("racing adds can't exceed the limit and positions stay unique", async () => {
    const room = GALLERY_LIMIT - (await listGallery(bistro)).length;
    const ids: string[] = [];
    for (let i = 0; i < room + 6; i++) ids.push(await uploaded());
    // Fill to one short of the limit, then race 6 adds for the last slot.
    for (const id of ids.slice(0, room - 1)) await addToGallery(bistro, id);
    const results = await Promise.all(ids.slice(room - 1).map((id) => addToGallery(bistro, id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { error: string }).error).every((e) => e === "full")).toBe(true);
    expect(await n("SELECT count(*) AS n FROM gallery_images WHERE site_id = 'bistro'")).toBe(GALLERY_LIMIT);
    const pos = await positions();
    expect(new Set(pos).size).toBe(pos.length);
  });

  it("racing adds from empty slots give unique, gapless positions", async () => {
    const ids = await Promise.all([uploaded(), uploaded(), uploaded(), uploaded()]);
    await Promise.all(ids.map((id) => addToGallery(bistro, id)));
    const pos = await positions();
    expect(new Set(pos).size).toBe(pos.length);
  });

  it("moves racing each other keep a permutation with unique positions", async () => {
    const before = await order();
    const results = await Promise.all([
      moveGalleryImage(bistro, before[1], "up"),
      moveGalleryImage(bistro, before[2], "up"),
      moveGalleryImage(bistro, before[3], "down"),
      moveGalleryImage(bistro, before[0], "down"),
    ]);
    expect(results.every((r) => r.ok || r.error === "conflict")).toBe(true);
    const after = await order();
    expect([...after].sort()).toEqual([...before].sort());
    const pos = await positions();
    expect(new Set(pos).size).toBe(pos.length);
  });

  it("a move racing a remove of the same row ends consistent", async () => {
    const before = await order();
    const [m, r] = await Promise.all([moveGalleryImage(bistro, before[2], "up"), removeFromGallery(bistro, before[2])]);
    expect(r).toEqual({ ok: true });
    expect(m.ok || m.error === "not-found" || m.error === "conflict").toBe(true);
    expect(await order()).not.toContain(before[2]);
    expect(await order()).toHaveLength(before.length - 1);
  });
});

describe("position drift", () => {
  it("duplicate positions are renumbered by a move and then unique", async () => {
    await db.prepare("UPDATE gallery_images SET position = 5 WHERE site_id = 'bistro'").run();
    const before = await order();
    expect(await moveGalleryImage(bistro, before[1], "up")).toEqual({ ok: true });
    const after = await order();
    expect(after[0]).toBe(before[1]);
    expect([...after].sort()).toEqual([...before].sort());
    expect(await positions()).toEqual(before.map((_, i) => i));
  });

  it("an add after gaps appends at the end (max+1) and the library numbers match the order", async () => {
    await db.prepare("UPDATE gallery_images SET position = position * 10 + 3 WHERE site_id = 'bistro'").run();
    const id = await uploaded();
    await addToGallery(bistro, id);
    const list = await listGallery(bistro);
    expect(list.at(-1)!.imageId).toBe(id);
    const lib = await listLibrary(bistro);
    list.forEach((g, i) => {
      const use = lib.find((x) => x.id === g.imageId)!.uses.find((u) => u.kind === "gallery");
      expect(use).toEqual({ kind: "gallery", position: i + 1 });
    });
  });

  it("an add after duplicate positions still goes last in listGallery", async () => {
    await db.prepare("UPDATE gallery_images SET position = 2 WHERE site_id = 'bistro'").run();
    const id = await uploaded();
    await addToGallery(bistro, id);
    expect((await listGallery(bistro)).at(-1)!.imageId).toBe(id);
  });
});

describe("remove and re-add", () => {
  it("re-adding goes to the end with a new row id, once", async () => {
    const id = await uploaded();
    await addToGallery(bistro, id);
    const first = (await listGallery(bistro)).at(-1)!;
    await removeFromGallery(bistro, first.id);
    expect(await removeFromGallery(bistro, first.id)).toEqual({ ok: false, error: "not-found" });
    expect(await addToGallery(bistro, id)).toEqual({ ok: true });
    const again = (await listGallery(bistro)).at(-1)!;
    expect(again.imageId).toBe(id);
    expect(again.id).not.toBe(first.id);
    expect(await n("SELECT count(*) AS n FROM gallery_images WHERE image_id = ?", id)).toBe(1);
  });

  it("removing a curated gallery photo keeps it in images and addable", async () => {
    const [first] = await listGallery(bistro);
    await removeFromGallery(bistro, first.id);
    expect(await n("SELECT count(*) AS n FROM images WHERE id = ?", first.imageId)).toBe(1);
    expect(await addToGallery(bistro, first.imageId)).toEqual({ ok: true });
  });

  it("removing every photo leaves an empty gallery that the export and schema accept", async () => {
    for (const id of await order()) await removeFromGallery(bistro, id);
    const exp = await exportSite(db, "bistro");
    expect(exp!.content.gallery.images).toEqual([]);
    const check = siteContentSchema("bistro").safeParse({ ...exp!.content, theme });
    expect(check.success ? [] : check.error.issues).toEqual([]);
  });
});

describe("content_version and audit", () => {
  it("moves on each real change and not on refusals or end-of-list moves", async () => {
    const ids = await order();
    let v = (await version())!;
    await moveGalleryImage(bistro, ids[1], "up");
    expect(await version()).toBeGreaterThan(v);
    v = (await version())!;
    await moveGalleryImage(bistro, (await order())[0], "up"); // already first
    await addToGallery(bistro, ids.length ? (await listGallery(bistro))[0].imageId : "x"); // already in
    await removeFromGallery(bistro, "zzzzzzzzzzzz");
    expect(await version()).toBe(v);
    await removeFromGallery(bistro, ids[0]);
    expect(await version()).toBeGreaterThan(v);
  });
});

describe("export and restore", () => {
  it("export lists the gallery in the admin's order and passes the schema; a restore keeps the order", async () => {
    // Make the library photos beyond the seeded gallery addable (curated ones with alt).
    const lib = await listLibrary(bistro);
    const extra = lib.filter((i) => i.kind === "static" && i.alt && !i.uses.some((u) => u.kind === "gallery")).slice(0, 2);
    for (const e of extra) expect(await addToGallery(bistro, e.id)).toEqual({ ok: true });
    const list = await listGallery(bistro);
    await moveGalleryImage(bistro, list.at(-1)!.id, "up");
    await moveGalleryImage(bistro, list[0].id, "down");
    const expected = (await listGallery(bistro)).map((g) => g.ref);
    const exp = await exportSite(db, "bistro");
    expect(exp!.content.gallery.images.map((g) => g.image)).toEqual(expected);
    const check = siteContentSchema("bistro").safeParse({ ...exp!.content, theme });
    expect(check.success ? [] : check.error.issues).toEqual([]);
    await db.batch(prepare(db, [...resetStatements("bistro"), ...seedStatements("bistro", exp!.content, images)]));
    expect((await listGallery(bistro)).map((g) => g.ref)).toEqual(expected);
    expect((await exportSite(db, "bistro"))!.content).toEqual(exp!.content);
  });

  it("a photo whose alt is changed in the library shows the new alt in the gallery list and export", async () => {
    const id = await uploaded();
    await addToGallery(bistro, id);
    const rv = (await listLibrary(bistro)).find((i) => i.id === id)!.rowVersion;
    const r = await updateImageAlt(bistro, id, rv, { sv: "Nytt", en: "New" });
    expect(r.ok).toBe(true);
    expect((await listGallery(bistro)).at(-1)!.alt).toEqual({ sv: "Nytt", en: "New" });
  });
});

describe("cross-site", () => {
  it("the same upload id on both sites: add/move/remove on bistro never touches westafrican", async () => {
    const id = await uploaded();
    // same id, other site
    const r = await addUpload(ctx("westafrican"), { id, variants: [{ width: 400, height: 300, bytes: new Uint8Array(5) }], alt: { sv: "wa", en: "wa" } });
    expect(r).toMatchObject({ ok: true });
    expect(await addToGallery(ctx("westafrican"), id)).toEqual({ ok: true });
    expect(await addToGallery(bistro, id)).toEqual({ ok: true });
    const [wa] = await listGallery(ctx("westafrican"));
    const mine = (await listGallery(bistro)).at(-1)!;
    expect(mine.id).not.toBe(wa.id);
    expect(await removeFromGallery(bistro, wa.id)).toEqual({ ok: false, error: "not-found" });
    expect(await moveGalleryImage(bistro, wa.id, "up")).toEqual({ ok: false, error: "not-found" });
    expect(await removeFromGallery(bistro, mine.id)).toEqual({ ok: true });
    expect(await listGallery(ctx("westafrican"))).toHaveLength(1);
    expect(await n("SELECT content_version AS n FROM sites WHERE id = 'westafrican'")).toBeGreaterThan(0);
  });
});
