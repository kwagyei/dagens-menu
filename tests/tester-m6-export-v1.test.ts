/**
 * Tester, M6.3 (ADR-014 §5): hand-made format 1 export files with odd shapes. Each must either
 * restore correctly or be refused with a clear message: never a crash, never silently wrong content.
 */
import { describe, expect, it } from "vitest";
import type { LibraryImage, Theme } from "../src/content/schema";
import { type OperatorContent, readExportFile } from "../src/db/export-file";
import { readSiteJson } from "./site-fixtures";

const SITE = "bistro";
const repo = readSiteJson(SITE);
const library = repo.images as LibraryImage[];
const altOf = new Map(library.map((i) => [i.ref, i.alt]));
const op: OperatorContent = { theme: repo.theme as Theme, settings: repo.settings, images: library };

/** A valid format 1 file built from the bistro fixtures: gallery { src, alt }, no library. */
function v1() {
  const { theme: _t, images: _i, ...content } = structuredClone(repo);
  content.gallery = { images: repo.gallery.images.map((g: { image: string }) => ({ src: g.image, alt: altOf.get(g.image) })) };
  return { format: "dagens-menu-export", formatVersion: 1, site: SITE, exportedAt: "2026-10-01T10:00:00Z", contentVersion: 3, content };
}
const read = (file: unknown) => readExportFile(JSON.stringify(file), SITE, op);

describe("format 1 files with odd shapes", () => {
  it("a clean v1 file restores with the gallery in order and every alt from the file or the repository", () => {
    const r = read(v1());
    if (!r.ok) throw new Error(r.error);
    expect(r.content.gallery.images.map((g) => g.image)).toEqual(repo.gallery.images.map((g: { image: string }) => g.image));
    expect(r.content.images.map((i) => i.ref)).toEqual(library.map((i) => i.ref));
  });

  it("highlightImages naming a deleted dish is dropped and counted", () => {
    const f = v1();
    f.content.pages.home.highlightImages = { zzzzzzzzzzzz: library[0].ref };
    const r = read(f);
    if (!r.ok) throw new Error(r.error);
    expect(r.highlightImagesDropped).toBe(1);
  });

  it("a gallery entry without alt: refused with a message, or restored with the repository's alt", () => {
    const f = v1();
    delete f.content.gallery.images[0].alt;
    const r = read(f);
    if (r.ok) expect(r.content.images.find((i) => i.ref === f.content.gallery.images[0].src)?.alt).toEqual(altOf.get(f.content.gallery.images[0].src));
    else expect(r.error).toMatch(/gallery\.images\.0/);
  });

  it("a gallery entry that is null is refused, not a crash", () => {
    const f = v1();
    f.content.gallery.images[0] = null;
    expect(() => read(f)).not.toThrow();
    expect(read(f).ok).toBe(false);
  });

  it("gallery.images that isn't a list is refused, not restored as an empty gallery", () => {
    const f = v1();
    f.content.gallery.images = { 0: f.content.gallery.images[0] };
    expect(read(f).ok).toBe(false);
  });

  it("an extra key on a v1 gallery entry is refused (v1 rejected it), not silently dropped", () => {
    const f = v1();
    f.content.gallery.images[0].caption = "Kept?";
    expect(read(f).ok).toBe(false);
  });

  it("an `images` key in a v1 file is refused (v1 had none), not silently overwritten", () => {
    const f = v1();
    (f.content as Record<string, unknown>).images = [{ ref: "/images/bistro/evil.jpg" }];
    expect(read(f).ok).toBe(false);
  });

  it("the same photo twice in a v1 gallery with different alts doesn't silently give both the same alt", () => {
    const f = v1();
    const first = f.content.gallery.images[0];
    f.content.gallery.images.push({ src: first.src, alt: { sv: "Annan text", en: "Other text" } });
    const r = read(f);
    if (r.ok) {
      // The model has one alt per image: the restore can't keep both. It should at least say so.
      expect.soft(r.content.images.find((i) => i.ref === first.src)?.alt, "first entry's alt was overwritten by the second").toEqual(first.alt);
    }
  });

  it("a v1 file naming a photo the repository no longer lists is refused, at that library entry's alt", () => {
    const f = v1();
    f.content.pages.home.heroImage = "/images/bistro/removed.jpg";
    const r = read(f);
    // Not in the repository library and not in the gallery, so it would have no alt (migration 0006).
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/images\.\d+\.alt/) });
  });

  it("formatVersion as a string is refused", () => {
    expect(read({ ...v1(), formatVersion: "1" })).toMatchObject({ ok: false, error: expect.stringContaining("format version") });
  });

  it("a v2 file still in the v1 gallery shape is refused with the path", () => {
    const r = read({ ...v1(), formatVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/gallery\.images\.0|images/);
  });
});
