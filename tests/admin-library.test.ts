/** The photo library's preview and "where it's used" text (plan M6.10). */
import { describe, expect, it } from "vitest";
import { describeUses, thumbnail } from "../src/admin/library";

describe("thumbnail", () => {
  it("an upload: its smallest stored size", () => {
    const id = "a".repeat(64);
    expect(thumbnail({ ref: id, width: 1200, height: 900 })).toEqual({ src: `/media/${id}-400.webp`, width: 400, height: 300 });
  });
  it("a built-in photo: its smallest build-time size", () => {
    expect(thumbnail({ ref: "/images/bistro/x.jpg", width: 1600, height: 1067 })!.src).toBe("/images/bistro/v/x-400.webp");
  });
  it("no size known: null, so the page shows the original", () => {
    expect(thumbnail({ ref: "/images/bistro/x.jpg", width: null, height: null })).toBeNull();
  });
});

describe("describeUses", () => {
  const uses = [
    { kind: "dish" as const, id: "abcdefghijkl", name: { sv: "Köttbullar", en: "Meatballs" } },
    { kind: "page" as const, slot: "menu_hero" as const },
    { kind: "gallery" as const, position: 3 },
  ];
  it("names each place in the page's language, with a link to change it", () => {
    expect(describeUses(uses, "sv")).toEqual([
      { label: "rätten Köttbullar", href: "/admin/menu/item/abcdefghijkl/photo/" },
      { label: "menysidans översta foto", href: "/admin/page-photos/menu_hero/" },
      { label: "galleriet, foto 3", href: "/admin/gallery/" },
    ]);
    expect(describeUses(uses, "en").map((u) => u.href)).toEqual(["/en/admin/menu/item/abcdefghijkl/photo/", "/en/admin/page-photos/menu_hero/", "/en/admin/gallery/"]);
    expect(describeUses(uses, "en")[0].label).toBe("the dish Meatballs");
  });
  it("every page slot has words in both languages", () => {
    for (const slot of ["hero", "cta", "menu_hero", "story", "kitchen"] as const) {
      for (const locale of ["sv", "en"] as const) expect(describeUses([{ kind: "page", slot }], locale)[0].label).not.toMatch(/^admin\./);
    }
  });
});
