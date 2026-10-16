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
  const item = (name: string): MenuItem => ({
    name: { sv: name, en: name },
    description: { sv: "", en: "" },
    price: 10000,
    tags: [],
    allergens: [],
    available: true,
  });
  const menu: Menu = {
    categories: [
      { id: "mains", name: { sv: "Varmrätter", en: "Mains" }, items: [item("a"), item("b")] },
      { id: "small-plates", name: { sv: "Smårätter", en: "Small plates" }, items: [item("c")] },
    ],
  };

  it("resolves ids to items in the order given", () => {
    expect(resolveHighlights(menu, ["mains-1", "mains-0"]).map((i) => i.name.en)).toEqual(["b", "a"]);
  });

  it("handles category ids that themselves contain a dash", () => {
    expect(resolveHighlights(menu, ["small-plates-0"]).map((i) => i.name.en)).toEqual(["c"]);
  });

  it("skips ids that do not resolve instead of throwing", () => {
    expect(resolveHighlights(menu, ["mains-9", "drinks-0", "mains", "mains-x"])).toEqual([]);
  });
});
