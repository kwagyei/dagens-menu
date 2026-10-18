/**
 * The gallery in the database (plan M6.10b): add a library photo at the end (once, with its
 * alt, while there is room), remove it (the photo stays), move it, each with an audit row and
 * a new content version, and never across sites.
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
import { addToGallery, GALLERY_LIMIT, listGallery, moveGalleryImage, removeFromGallery } from "../../src/db/gallery";
import { listLibrary } from "../../src/db/library";
import { addUpload } from "../../src/db/photos";
import type { RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const ctx = (siteId: string): RepoContext => ({ db, siteId, userId: "owner1", now: new Date("2026-10-17T12:00:00Z") });
const bistro = ctx("bistro");
const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
const hashes = new Map<string, string>();
const images: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });

let counter = 0;
async function uploaded(site = "bistro"): Promise<string> {
  const id = (++counter).toString(16).padStart(64, "b");
  const result = await addUpload(ctx(site), { id, variants: [{ width: 400, height: 300, bytes: crypto.getRandomValues(new Uint8Array(300)) }], alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` } });
  expect(result).toMatchObject({ ok: true });
  return id;
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

describe("listGallery", () => {
  it("is the seeded gallery, in order, with each photo's alt and reference", async () => {
    const list = await listGallery(bistro);
    expect(list.map((g) => g.ref)).toEqual(gallery.images.map((g) => g.image));
    expect(list.every((g) => g.alt?.sv && g.alt.en && /^[a-z0-9]{12}$/.test(g.id))).toBe(true);
  });
});

describe("addToGallery", () => {
  it("adds a library photo at the end with its alt, audits it and moves the content version", async () => {
    const id = await uploaded();
    const v = await version();
    expect(await addToGallery(bistro, id)).toEqual({ ok: true });
    const list = await listGallery(bistro);
    expect(list.at(-1)).toMatchObject({ imageId: id, ref: id, alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` } });
    expect(await count("SELECT count(*) AS n FROM gallery_images WHERE image_id = ?", id)).toBe(1);
    expect(await version()).toBeGreaterThan(v!);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'gallery_image' AND action = 'create' AND user_id = 'owner1'")).toBe(1);
    // The library now counts it as used, by position.
    const used = (await listLibrary(bistro)).find((i) => i.id === id)!;
    expect(used.uses).toEqual([{ kind: "gallery", position: list.length }]);
  });

  it("refuses a photo already in the gallery, and writes nothing", async () => {
    const id = await uploaded();
    await addToGallery(bistro, id);
    const v = await version();
    expect(await addToGallery(bistro, id)).toEqual({ ok: false, error: "already" });
    expect(await count("SELECT count(*) AS n FROM gallery_images WHERE image_id = ?", id)).toBe(1);
    expect(await version()).toBe(v);
  });

  it("refuses when the gallery is full", async () => {
    const room = GALLERY_LIMIT - (await listGallery(bistro)).length;
    for (let i = 0; i < room; i++) expect(await addToGallery(bistro, await uploaded())).toEqual({ ok: true });
    expect(await addToGallery(bistro, await uploaded())).toEqual({ ok: false, error: "full" });
    expect((await listGallery(bistro)).length).toBe(GALLERY_LIMIT);
  });

  it("can't add another site's photo, an unknown one or a malformed id", async () => {
    const theirs = await uploaded("westafrican");
    for (const id of [theirs, "e".repeat(64), "../x", "A".repeat(64)]) expect(await addToGallery(bistro, id)).toEqual({ ok: false, error: "not-found" });
    expect(await count("SELECT count(*) AS n FROM gallery_images WHERE image_id = ?", theirs)).toBe(0);
  });
});

describe("removeFromGallery", () => {
  it("takes the photo out of the gallery and keeps the photo", async () => {
    const id = await uploaded();
    await addToGallery(bistro, id);
    const entry = (await listGallery(bistro)).find((g) => g.imageId === id)!;
    expect(await removeFromGallery(bistro, entry.id)).toEqual({ ok: true });
    expect((await listGallery(bistro)).some((g) => g.imageId === id)).toBe(false);
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", id)).toBe(1);
    expect((await listLibrary(bistro)).find((i) => i.id === id)!.uses).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'gallery_image' AND action = 'delete'")).toBe(1);
  });

  it("answers not-found for an unknown or malformed row id, and another site's row", async () => {
    const theirs = await uploaded("westafrican");
    await addToGallery(ctx("westafrican"), theirs);
    const [their] = await listGallery(ctx("westafrican"));
    for (const id of ["zzzzzzzzzzzz", "../x", their.id]) expect(await removeFromGallery(bistro, id)).toEqual({ ok: false, error: "not-found" });
    expect(await listGallery(ctx("westafrican"))).toHaveLength(1);
  });
});

describe("moveGalleryImage", () => {
  it("swaps a photo with its neighbour; at either end it stays", async () => {
    const before = await listGallery(bistro);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(await moveGalleryImage(bistro, before[1].id, "up")).toEqual({ ok: true });
    const after = await listGallery(bistro);
    expect(after.slice(0, 2).map((g) => g.id)).toEqual([before[1].id, before[0].id]);
    expect(await moveGalleryImage(bistro, after[0].id, "up")).toEqual({ ok: true });
    expect((await listGallery(bistro)).map((g) => g.id)).toEqual(after.map((g) => g.id));
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'gallery_image' AND action = 'reorder'")).toBe(1);
  });

  it("can't move another site's row", async () => {
    const theirs = await uploaded("westafrican");
    await addToGallery(ctx("westafrican"), theirs);
    const [their] = await listGallery(ctx("westafrican"));
    expect(await moveGalleryImage(bistro, their.id, "down")).toEqual({ ok: false, error: "not-found" });
  });
});
