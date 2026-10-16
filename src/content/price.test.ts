import { describe, expect, it } from "vitest";
import { formatPrice } from "./load";
import { MAX_PRICE_ORE, parseKronor, type PriceError } from "./price";

const NBSP = " ";
const NNBSP = " ";

describe("parseKronor accepts how owners write prices", () => {
  it.each([
    ["145", 14500],
    ["145 kr", 14500],
    ["145kr", 14500],
    ["145 KR", 14500],
    ["145 kr.", 14500],
    ["145 SEK", 14500],
    ["145:-", 14500],
    ["145 :-", 14500],
    ["145,-", 14500],
    ["145,50", 14550],
    ["145.50", 14550],
    ["145,5", 14550],
    ["145,05", 14505],
    ["0", 0],
    ["0,99", 99],
    ["1 250", 125000],
    [`1${NBSP}250`, 125000],
    [`1${NNBSP}250`, 125000],
    ["1 250,50 kr", 125050],
    ["12 500", 1250000],
    ["1  250", 125000], // a doubled space is a typo, not a different number
    ["  145 kr  ", 14500],
    ["100 000", MAX_PRICE_ORE],
  ])("%j → %i öre", (input, ore) => {
    expect(parseKronor(input)).toEqual({ ok: true, ore });
  });
});

describe("parseKronor rejects rather than guesses", () => {
  it.each<[string, PriceError]>([
    ["", "empty"],
    ["   ", "empty"],
    ["-145", "negative"],
    ["−145", "negative"],
    ["145,505", "too-many-decimals"],
    // "1,250" is English for 1 250 but Swedish for 1.25: ambiguous, so not accepted.
    ["1,250", "too-many-decimals"],
    ["100 000,01", "too-large"],
    ["1 000 000", "too-large"],
    ["etthundra", "invalid"],
    ["ca 145", "invalid"],
    ["145-195", "invalid"],
    ["fr. 145 kr", "invalid"],
    ["12 50", "invalid"],
    ["145 kr kr", "invalid"],
    ["1e3", "invalid"],
    ["+145", "invalid"],
    ["145,", "invalid"],
    [",50", "invalid"],
    ["€145", "invalid"],
  ])("%j → %s", (input, error) => {
    expect(parseKronor(input)).toEqual({ ok: false, error });
  });
});

describe("parseKronor and formatPrice", () => {
  it.each([0, 1, 99, 100, 14500, 14550, 14505, 99999, 125050, 1234500, MAX_PRICE_ORE])(
    "round-trips %i öre",
    (ore) => {
      expect(parseKronor(formatPrice(ore))).toEqual({ ok: true, ore });
    },
  );
});
