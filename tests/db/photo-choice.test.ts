/**
 * Choosing a dish's or a page slot's photo (plan M6.10c): one guarded update of one column, only
 * this site's photo with alt (or none), no change to the row's row_version, nothing written
 * when the choice is already the current one, and the library sees the new use.
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
import { siteContentSchema, type Theme } from "../../src/content/schema";
import { D1ContentSource } from "../../src/content/d1-source";
import { getLibraryImage } from "../../src/db/library";
import { dishPhoto, pagePhotos, setDishPhoto, setPagePhoto } from "../../src/db/photo-choice";
import { addUpload } from "../../src/db/photos";
import { getMenuItem, type RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const ctx = (siteId: string): RepoContext => ({ db, siteId, userId: "owner1", now: new Date("2026-10-18T10:00:00Z") });
const bistro = ctx("bistro");
const { theme: _t, ...content } = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
const hashes = new Map<string, string>();
const images: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const DISH = menu.categories[0].items[0].id;

let counter = 0;
async function uploaded(site = "bistro"): Promise<string> {
  const id = (++counter).toString(16).padStart(64, "c");
  expect(
    await addUpload(ctx(site), {
      id,
      variants: [{ width: 400, height: 300, bytes: crypto.getRandomValues(new Uint8Array(300)) }],
      alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` },
    }),
  ).toMatchObject({ ok: true });
  return id;
}
const audits = () => db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'update'").first<number>("n");
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

describe("setDishPhoto", () => {
  it("puts an upload on a dish: audited, version moved, row_version kept, and the library sees the use", async () => {
    const id = await uploaded();
    const before = (await getMenuItem(bistro, DISH))!;
    const v = await version();
    expect(await setDishPhoto(bistro, DISH, id)).toEqual({ ok: true });
    expect(await dishPhoto(bistro, DISH)).toBe(id);
    expect((await getMenuItem(bistro, DISH))!.rowVersion).toBe(before.rowVersion);
    expect(await version()).toBeGreaterThan(v!);
    expect((await getLibraryImage(bistro, id))!.uses).toEqual([{ kind: "dish", id: DISH, name: menu.categories[0].items[0].name }]);
    // The public content shows it, with its alt in the library.
    const live = await new D1ContentSource(db, "bistro", theme as Theme).load({ now: new Date() });
    const dish = live.content.menu.categories.flatMap((c) => c.items).find((i) => i.id === DISH)!;
    expect(dish.image).toBe(id);
  });

  it("no photo, and the same choice twice, write once each", async () => {
    const id = await uploaded();
    await setDishPhoto(bistro, DISH, id);
    const n = await audits();
    expect(await setDishPhoto(bistro, DISH, id)).toEqual({ ok: true });
    expect(await audits()).toBe(n);
    expect(await setDishPhoto(bistro, DISH, null)).toEqual({ ok: true });
    expect(await dishPhoto(bistro, DISH)).toBeNull();
    expect(await audits()).toBe(n! + 1);
  });

  it("refuses another site's photo, an unknown one and a malformed one; nothing changes", async () => {
    const before = await dishPhoto(bistro, DISH);
    const theirs = await uploaded("westafrican");
    for (const id of [theirs, "d".repeat(64), "../x", "A".repeat(64)]) expect(await setDishPhoto(bistro, DISH, id)).toEqual({ ok: false, error: "not-found" });
    expect(await dishPhoto(bistro, DISH)).toBe(before);
  });

  it("an unknown dish, or another site's, is not found", async () => {
    expect(await setDishPhoto(bistro, "zzzzzzzzzzzz", null)).toEqual({ ok: false, error: "not-found" });
    expect(await setDishPhoto(ctx("westafrican"), DISH, null)).toEqual({ ok: false, error: "not-found" });
  });
});

describe("setPagePhoto", () => {
  it("changes one slot only, keeps the texts' row_version, and the library sees the use", async () => {
    const id = await uploaded();
    const before = (await pagePhotos(bistro))!;
    const rowVersion = await db.prepare("SELECT row_version AS v FROM page_content WHERE site_id = 'bistro'").first<number>("v");
    expect(await setPagePhoto(bistro, "story", id)).toEqual({ ok: true });
    const after = (await pagePhotos(bistro))!;
    expect(after).toEqual({ ...before, story: id });
    expect(await db.prepare("SELECT row_version AS v FROM page_content WHERE site_id = 'bistro'").first<number>("v")).toBe(rowVersion);
    expect((await getLibraryImage(bistro, id))!.uses).toEqual([{ kind: "page", slot: "story" }]);
  });

  it("no photo in a slot is allowed, and the content still loads", async () => {
    expect(await setPagePhoto(bistro, "hero", null)).toEqual({ ok: true });
    expect((await pagePhotos(bistro))!.hero).toBeNull();
    const live = await new D1ContentSource(db, "bistro", theme as Theme).load({ now: new Date() });
    expect(live.content.pages.home.heroImage).toBeUndefined();
  });

  it("refuses an unknown slot, another site's photo and a malformed id", async () => {
    const theirs = await uploaded("westafrican");
    const before = await pagePhotos(bistro);
    expect(await setPagePhoto(bistro, "logo" as never, null)).toEqual({ ok: false, error: "not-found" });
    expect(await setPagePhoto(bistro, "hero", theirs)).toEqual({ ok: false, error: "not-found" });
    expect(await setPagePhoto(bistro, "hero", "x'; DROP TABLE images; --")).toEqual({ ok: false, error: "not-found" });
    expect(await pagePhotos(bistro)).toEqual(before);
  });
});
