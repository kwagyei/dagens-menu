/**
 * Tester's edge cases for parseKronor, beyond src/content/price.test.ts.
 * Spec (ADR-011 §8, plan M1.3): accept 145, 145 kr, 145:-, 145,50, 145.50, 1 250;
 * reject everything else with a reason; range 0 to 100 000 kr.
 */
import { describe, expect, it } from "vitest";
import { MAX_PRICE_ORE, parseKronor } from "./price";

describe("parseKronor: other whitespace", () => {
  it.each([
    ["tab before kr", "145\tkr", 14500],
    ["thin space grouping", "1 250", 125000],
    ["figure space grouping", "1 250", 125000],
    ["trailing newline from a textarea", "145\n", 14500],
  ])("%s", (_name, input, ore) => {
    expect(parseKronor(input)).toEqual({ ok: true, ore });
  });
});

describe("parseKronor: digits that are not ASCII", () => {
  it("rejects Arabic-Indic digits rather than misreading them", () => {
    expect(parseKronor("١٤٥").ok).toBe(false);
  });
  it("folds full-width digits (NFKC) to the same price", () => {
    expect(parseKronor("１４５")).toEqual({ ok: true, ore: 14500 });
  });
});

describe("parseKronor: forms outside the spec are rejected", () => {
  it.each(["145.-", "SEK 145", "kr 145", "145 kronor", "145 kr:-", "1.250,50", "NaN", "Infinity", "0x91", "1_000", "145 kr 50"])("%j", (input) => {
    expect(parseKronor(input).ok).toBe(false);
  });
});

describe("parseKronor: leading zeros and boundaries", () => {
  it("reads leading zeros as the same number", () => {
    expect(parseKronor("0145")).toEqual({ ok: true, ore: 14500 });
  });
  it("accepts exactly the maximum with decimals", () => {
    expect(parseKronor("100 000,00")).toEqual({ ok: true, ore: MAX_PRICE_ORE });
    expect(parseKronor("99 999,99")).toEqual({ ok: true, ore: MAX_PRICE_ORE - 1 });
  });
  it("calls an unsafe integer too large, not a wrong price", () => {
    expect(parseKronor("9007199254740993")).toEqual({ ok: false, error: "too-large" });
    expect(parseKronor("9".repeat(400))).toEqual({ ok: false, error: "too-large" });
  });
  it("is fast on a very long input", () => {
    const start = performance.now();
    parseKronor(`${"1 ".repeat(200_000)}x`);
    parseKronor(" ".repeat(500_000) + "145");
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("parseKronor: rejection reasons", () => {
  // The reason becomes the admin's message; it should say what is actually wrong.
  it("calls a Unicode hyphen-minus look-alike negative", () => {
    expect(parseKronor("‐145")).toEqual({ ok: false, error: "negative" });
  });
  it("treats input that is only a zero-width space as empty", () => {
    expect(parseKronor("​")).toEqual({ ok: false, error: "empty" });
  });
  it("accepts a price pasted with a trailing zero-width space", () => {
    expect(parseKronor("145​")).toEqual({ ok: true, ore: 14500 });
  });
});
