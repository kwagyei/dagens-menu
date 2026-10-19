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
import { siteContentSchema } from "../../src/content/schema";
import { dishPhoto, pagePhotos, setDishPhoto, setPagePhoto } from "../../src/db/photo-choice";
import { addUpload } from "../../src/db/photos";
import { getMenuItem, type RepoContext } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { deleteImage } from "../../src/db/library";
import { updateMenuItem } from "../../src/db/repository";
import { adminTexts, updatePageTexts } from "../../src/db/texts";

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

const editOf = async () => {
  const d = (await getMenuItem(bistro, DISH))!;
  return { name: d.name, description: d.description, priceOre: d.priceOre, tags: d.tags, allergens: d.allergens, available: d.available };
};

describe("tester M6.10c: interactions", () => {
  it("saving the dish form after a photo choice keeps the photo; a form opened before the choice still saves", async () => {
    const id = await uploaded();
    const stale = (await getMenuItem(bistro, DISH))!.rowVersion;
    await setDishPhoto(bistro, DISH, id);
    expect(await updateMenuItem(bistro, DISH, stale, { ...(await editOf()), priceOre: 12300 })).toEqual({ ok: true });
    expect(await dishPhoto(bistro, DISH)).toBe(id);
  });

  it("the texts form opened before a page photo change still saves, and keeps all five slots", async () => {
    const id = await uploaded();
    const t = (await adminTexts(bistro))!;
    for (const s of ["hero", "cta", "menu_hero", "story", "kitchen"] as const) await setPagePhoto(bistro, s, id);
    const { rowVersion, ...texts } = t.pages;
    expect(await updatePageTexts(bistro, rowVersion, texts)).toEqual({ ok: true });
    expect(Object.values((await pagePhotos(bistro))!)).toEqual([id, id, id, id, id]);
  });

  it("a chosen photo cannot be deleted, a released one can, and a deleted one cannot be chosen", async () => {
    const id = await uploaded();
    await setDishPhoto(bistro, DISH, id);
    await setPagePhoto(bistro, "kitchen", id);
    expect(await deleteImage(bistro, id)).toMatchObject({ ok: false, error: "in-use" });
    await setDishPhoto(bistro, DISH, null);
    expect(await deleteImage(bistro, id)).toMatchObject({ ok: false, error: "in-use" });
    await setPagePhoto(bistro, "kitchen", null);
    expect(await deleteImage(bistro, id)).toEqual({ ok: true });
    expect(await setDishPhoto(bistro, DISH, id)).toEqual({ ok: false, error: "not-found" });
    expect(await setPagePhoto(bistro, "kitchen", id)).toEqual({ ok: false, error: "not-found" });
  });

  it("a chosen photo's alt can't be removed (migration 0006), so the page never shows it without one", async () => {
    const id = await uploaded();
    await setPagePhoto(bistro, "hero", id);
    await expect(db.prepare("UPDATE images SET alt_sv = NULL, alt_en = NULL WHERE id = ?").bind(id).run()).rejects.toThrow(/alt text in Swedish and English/);
    expect(await setPagePhoto(bistro, "hero", null)).toEqual({ ok: true });
  });

  it("a built-in photo (static) can be chosen, and page choices bump content_version and audit once", async () => {
    const builtIn = hashes.values().next().value as string;
    const v = await version();
    const n = await audits();
    expect(await setPagePhoto(bistro, "cta", builtIn)).toEqual({ ok: true });
    expect(await version()).toBeGreaterThan(v!);
    expect(await audits()).toBe(n! + 1);
  });

  it("concurrent different choices on different slots both land; same slot ends on one of them", async () => {
    const a = await uploaded();
    const b = await uploaded();
    await Promise.all([setPagePhoto(bistro, "hero", a), setPagePhoto(bistro, "story", b)]);
    expect(await pagePhotos(bistro)).toMatchObject({ hero: a, story: b });
    await Promise.all([setPagePhoto(bistro, "cta", a), setPagePhoto(bistro, "cta", b)]);
    expect([a, b]).toContain((await pagePhotos(bistro))!.cta);
  });

  it("odd ids: uppercase, 63 chars, whitespace, unicode and the empty string change nothing", async () => {
    const before = await pagePhotos(bistro);
    for (const bad of ["", " ", "a".repeat(63), "a".repeat(65), "a".repeat(63) + "\n", "é".repeat(64), "%00"]) {
      const r = await setPagePhoto(bistro, "hero", bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(await pagePhotos(bistro)).toEqual(before);
  });

  it("slot names with SQL or path tricks are refused", async () => {
    for (const s of ["hero_image_id", "hero; --", "../hero", "HERO", "constructor", "__proto__", "toString"]) {
      expect(await setPagePhoto(bistro, s as never, null)).toEqual({ ok: false, error: "not-found" });
    }
  });
});
