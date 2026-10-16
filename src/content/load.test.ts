import { describe, expect, it } from "vitest";
import { formatPrice, localized, resolveHighlights, type Menu, type MenuItem } from "./load";

const NBSP = " ";

describe("formatPrice", () => {
  it.each([
    [14500, `145${NBSP}kr`],
    [12550, `125,50${NBSP}kr`],
    [12505, `125,05${NBSP}kr`],
    [0, `0${NBSP}kr`],
    [99, `0,99${NBSP}kr`],
    [100000, `1${NBSP}000${NBSP}kr`],
    [125050, `1${NBSP}250,50${NBSP}kr`],
    [123456700, `1${NBSP}234${NBSP}567${NBSP}kr`],
  ])("formats %i öre as %j", (minor, expected) => {
    expect(formatPrice(minor)).toBe(expected);
  });

  it("never contains a breakable space", () => {
    expect(formatPrice(125050)).not.toMatch(/ /);
  });

  it.each([-100, 145.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (bad) => {
    expect(() => formatPrice(bad)).toThrow(RangeError);
  });
});

describe("localized", () => {
  const field = { sv: "Lunch idag", en: "Lunch today" };

  it("returns English for en", () => {
    expect(localized(field, "en")).toBe("Lunch today");
  });

  it("falls back to Swedish for sv and for unknown locales", () => {
    expect(localized(field, "sv")).toBe("Lunch idag");
    expect(localized(field, "de")).toBe("Lunch idag");
  });
});

describe("resolveHighlights", () => {
  const item = (id: string, available = true): MenuItem => ({
    id,
    name: { sv: id, en: id },
    description: { sv: "", en: "" },
    price: 10000,
    tags: [],
    allergens: [],
    available,
  });
  const menu: Menu = {
    categories: [
      { id: "mains", name: { sv: "Varmrätter", en: "Mains" }, items: [item("aaaaaaaaaaaa"), item("bbbbbbbbbbbb")] },
      { id: "desserts", name: { sv: "Efterrätter", en: "Desserts" }, items: [item("cccccccccccc", false)] },
    ],
  };
  const resolved = (m: Menu, ids: string[]) => resolveHighlights(m, ids).map((h) => h.id);

  it("resolves ids to items in the order given, keeping each id", () => {
    const result = resolveHighlights(menu, ["bbbbbbbbbbbb", "aaaaaaaaaaaa"]);
    expect(result.map((h) => [h.id, h.item.id])).toEqual([
      ["bbbbbbbbbbbb", "bbbbbbbbbbbb"],
      ["aaaaaaaaaaaa", "aaaaaaaaaaaa"],
    ]);
  });

  it("is unaffected by reordering items within or across categories", () => {
    const reordered: Menu = {
      categories: [
        { ...menu.categories[1], items: [...menu.categories[1].items, menu.categories[0].items[0]] },
        { ...menu.categories[0], items: [menu.categories[0].items[1]] },
      ],
    };
    expect(resolved(reordered, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])).toEqual(resolved(menu, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]));
  });

  it("skips unknown ids and unavailable items instead of throwing", () => {
    expect(resolved(menu, ["zzzzzzzzzzzz", "cccccccccccc", "aaaaaaaaaaaa"])).toEqual(["aaaaaaaaaaaa"]);
  });
});
