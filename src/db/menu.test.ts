import { describe, expect, it } from "vitest";
import { moved, slugify } from "./menu";

describe("slugify", () => {
  it.each([
    ["Varmrätter", "varmratter"],
    ["Förrätter & smårätter", "forratter-smaratter"],
    ["  Dagens lunch!  ", "dagens-lunch"],
    ["Öl / Vin", "ol-vin"],
    ["🍲🍲", "kategori"],
    ["x".repeat(60), "x".repeat(40)],
  ])("%j → %j", (input, slug) => {
    expect(slugify(input)).toBe(slug);
  });

  it("always gives a slug the database accepts", () => {
    for (const input of ["A-", "-a", "a--b", "ä-", "---"]) expect(slugify(input)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("moved", () => {
  it("swaps with the neighbour in the given direction", () => {
    expect(moved(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
  });

  it("does nothing at either end or for an unknown id", () => {
    expect(moved(["a", "b"], "a", "up")).toBeNull();
    expect(moved(["a", "b"], "b", "down")).toBeNull();
    expect(moved(["a", "b"], "z", "up")).toBeNull();
  });
});
