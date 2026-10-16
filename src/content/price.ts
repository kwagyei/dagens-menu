/**
 * Parse a price the way a Swedish restaurant owner types it, into öre.
 *
 * Accepted: "145", "145 kr", "145 kr.", "145 SEK", "145:-", "145,-", "145,50", "145.50",
 * "1 250" (thousands grouped with a space, no-break space or narrow no-break space), and
 * the output of formatPrice() itself. Everything else is rejected with a reason the admin
 * can turn into a message, rather than guessed at: a price that is silently wrong is worse
 * than a form that asks again.
 */

/** 100 000 kr. Anything above is almost certainly a typo (ADR-011 §8). */
export const MAX_PRICE_ORE = 100_000 * 100;

export type PriceError = "empty" | "negative" | "too-many-decimals" | "too-large" | "invalid";

export type PriceParseResult = { ok: true; ore: number } | { ok: false; error: PriceError };

const SUFFIX = /\s*(?:kr\.?|sek|:-|,-)$/i;
// Either plain digits, or 1–3 digits followed by space-separated groups of exactly three.
const AMOUNT = /^(\d+|\d{1,3}(?: \d{3})+)(?:[.,](\d+))?$/;

export function parseKronor(input: string): PriceParseResult {
  // NFKC folds no-break and narrow no-break spaces into ordinary spaces.
  const text = input.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (text === "") return { ok: false, error: "empty" };
  if (/^[-−–]/.test(text)) return { ok: false, error: "negative" };

  const match = text.replace(SUFFIX, "").match(AMOUNT);
  if (!match) return { ok: false, error: "invalid" };

  const [, whole, fraction = ""] = match;
  if (fraction.length > 2) return { ok: false, error: "too-many-decimals" };

  const ore = Number(whole.replace(/ /g, "")) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(ore) || ore > MAX_PRICE_ORE) return { ok: false, error: "too-large" };
  return { ok: true, ore };
}
