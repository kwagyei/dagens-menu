/**
 * Tester, M6.3 (ADR-014 §1): hostile inputs to the image library beyond the parity cases.
 * Each case either must be refused (at the reference's own path) or is documented as accepted.
 */
import { describe, expect, it } from "vitest";
import { siteContentSchema } from "../src/content/schema";
import { readSiteJson } from "./site-fixtures";

type Content = ReturnType<typeof readSiteJson>;
const SITE = "bistro";
const base = readSiteJson(SITE);
const UPLOAD = "a".repeat(64);

function issuesAfter(mutate: (c: Content) => void): Array<{ path: string; message: string }> {
  const copy = structuredClone(base);
  mutate(copy);
  const result = siteContentSchema(SITE).safeParse(copy);
  return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("image library: refused", () => {
  const refused: Array<[string, (c: Content) => void, string]> = [
    ["a ref in a nested folder", (c) => (c.images[0].ref = "/images/bistro/sub/x.jpg"), "images.0.ref"],
    ["a ref that is ..", (c) => (c.images[0].ref = "/images/bistro/.."), "images.0.ref"],
    ["a ref with an encoded slash", (c) => (c.images[0].ref = "/images/bistro/..%2Fx.jpg"), "images.0.ref"],
    ["a ref with a trailing newline", (c) => (c.images[0].ref = `${c.images[0].ref}\n`), "images.0.ref"],
    ["an upload id 63 chars", (c) => (c.images[0].ref = "a".repeat(63)), "images.0.ref"],
    ["an upload id with a non-hex letter", (c) => (c.images[0].ref = `${"a".repeat(63)}g`), "images.0.ref"],
    ["a gallery upload not in the library", (c) => (c.gallery.images[0].image = UPLOAD), "gallery.images.0.image"],
    ["an alt of only zero-width characters", (c) => (c.images[0].alt.en = "​⁠﻿"), "images.0.alt.en"],
    ["an alt over the short cap", (c) => (c.images[0].alt.sv = "x".repeat(1000)), "images.0.alt.sv"],
    ["width 0", (c) => (c.images[0].width = 0), "images.0.width"],
    ["width fractional", (c) => (c.images[0].width = 1.5), "images.0.width"],
    ["height over 10000", (c) => (c.images[0].height = 10001), "images.0.height"],
    ["a __proto__ key on an image", (c) => (c.images[0] = JSON.parse(`{"ref":"${c.images[0].ref}","__proto__":{"x":1}}`)), "images.0"],
    ["images not an array", (c) => (c.images = {}), "images"],
    ["the gallery entry keeps an old alt", (c) => (c.gallery.images[0].alt = { sv: "x", en: "y" }), "gallery.images.0"],
    ["the gallery entry in the old src shape", (c) => (c.gallery.images[0] = { src: c.gallery.images[0].image, alt: { sv: "x", en: "y" } }), "gallery.images.0"],
  ];
  it.each(refused)("%s", (_rule, mutate, path) => {
    const issues = issuesAfter(mutate);
    expect(issues.map((i) => i.path)).toContain(path);
  });
});

describe("image library: accepted by design", () => {
  it("an upload id used in the gallery, listed with alt", () => {
    expect(
      issuesAfter((c) => {
        c.images.push({ ref: UPLOAD, alt: { sv: "Ett foto", en: "A photo" } });
        c.gallery.images[0].image = UPLOAD;
      }),
    ).toEqual([]);
  });

  it("the same image twice in the gallery", () => {
    expect(issuesAfter((c) => c.gallery.images.push({ ...c.gallery.images[0] }))).toEqual([]);
  });

  it("an unused library entry without alt (expand release)", () => {
    expect(issuesAfter((c) => c.images.push({ ref: "/images/bistro/unused.jpg" }))).toEqual([]);
  });
});

describe("image library fixtures", () => {
  for (const site of ["bistro", "westafrican"] as const) {
    const c = readSiteJson(site);
    it(`${site}: images.json is in byte order with alt on every entry and no 'Bild av' or file names`, () => {
      const refs = c.images.map((i: { ref: string }) => i.ref);
      expect(refs).toEqual([...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      for (const i of c.images as Array<{ ref: string; alt?: { sv: string; en: string } }>) {
        expect(i.alt, i.ref).toBeDefined();
        for (const text of [i.alt!.sv, i.alt!.en]) {
          expect(text, i.ref).not.toMatch(/^(bild av|bild på|image of|picture of|photo of)\b/i);
          expect(text, i.ref).not.toMatch(/\.(jpe?g|webp|png)\b/i);
          expect(text, i.ref).toBe(text.normalize("NFC"));
          expect(text, i.ref).not.toMatch(/[\p{Cf}\n]/u);
        }
      }
    });
  }
});
