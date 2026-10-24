/** The srcset helper (plan M6.9; ADR-015 §4). */
import { describe, expect, it } from "vitest";
import { cssUrl, curatedVariantUrl, photoSources } from "../src/content/images";
import { checkLadder } from "../src/server/upload-validate";

describe("photoSources", () => {
  it("a curated photo: build-time sizes under the site's own v/ folder, 800 as the fallback", () => {
    const p = photoSources({ ref: "/images/bistro/kottbullar-hero.jpg", width: 1920, height: 1280 })!;
    expect(p.srcset).toBe(
      "/images/bistro/v/kottbullar-hero-400.webp 400w, /images/bistro/v/kottbullar-hero-800.webp 800w, /images/bistro/v/kottbullar-hero-1200.webp 1200w, /images/bistro/v/kottbullar-hero-1600.webp 1600w",
    );
    expect(p.src).toBe("/images/bistro/v/kottbullar-hero-800.webp");
    expect({ width: p.width, height: p.height }).toEqual({ width: 1600, height: 1067 });
    expect(checkLadder(p.sizes).ok).toBe(true);
  });

  it("a curated photo just above a step is cut to it, as the build script makes it", () => {
    expect(photoSources({ ref: "/images/bistro/x.jpg", width: 1242, height: 2208 })!.sizes.map((s) => s.width)).toEqual([400, 800, 1200]);
  });

  it("a small curated photo: one size, which is also the fallback", () => {
    const p = photoSources({ ref: "/images/westafrican/a.b.jpg", width: 600, height: 400 })!;
    expect(p.sizes.map((s) => s.width)).toEqual([400, 600]);
    expect(p.src).toBe("/images/westafrican/v/a.b-600.webp");
  });

  it("an upload: its stored sizes from /media, the master last", () => {
    const id = "a".repeat(64);
    const p = photoSources({ ref: id, width: 1242, height: 2208 })!;
    expect(p.sizes.map((s) => s.url)).toEqual([400, 800, 1200, 1242].map((w) => `/media/${id}-${w}.webp`));
    expect(p.width).toBe(1242);
  });

  it("no size known, or too narrow for the ladder: null, so the page keeps the original", () => {
    expect(photoSources({ ref: "/images/bistro/x.jpg" })).toBeNull();
    expect(photoSources({ ref: "/images/bistro/x.jpg", width: 200, height: 100 })).toBeNull();
  });
});

describe("curatedVariantUrl", () => {
  it("keeps the photo in its own site's folder", () => {
    expect(curatedVariantUrl("/images/bistro/köttbullar.jpeg", 400)).toBe("/images/bistro/v/köttbullar-400.webp");
  });
});

describe("cssUrl", () => {
  it("wraps a curated path and an upload's variant path", () => {
    expect(cssUrl("/images/bistro/hero.jpg")).toBe('url("/images/bistro/hero.jpg")');
    expect(cssUrl(`/media/${"a".repeat(64)}-1200.webp`)).toBe(`url("/media/${"a".repeat(64)}-1200.webp")`);
  });
  it.each([
    ["a closing paren and a new declaration", '/x.jpg");background:url(https://evil.example/t'],
    ["a quote", '/x".jpg'],
    ["a semicolon", "/x.jpg;color:red"],
    ["an absolute URL", "https://cdn.example/x.jpg"],
    ["a backslash escape", "/x\\29.jpg"],
    ["whitespace", "/x .jpg"],
    ["nothing", ""],
    ["undefined", undefined],
  ])("refuses %s", (_what, path) => {
    expect(cssUrl(path)).toBeNull();
  });
});
