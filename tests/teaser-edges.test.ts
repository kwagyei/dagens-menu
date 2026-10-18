import { describe, expect, it } from "vitest";
import { teaser } from "../src/content/teaser";

const filler = " Och så vidare med en lång fortsättning som gör att texten överstiger gränsen för teasern ganska rejält nu.";
const long = (s: string) => s + filler.repeat(3);

describe("teaser edge cases", () => {
  it("returns a prefix of the story when a sentence holds a decimal number", () => {
    const text = long("Vi bakar bröd i 2.5 timmar varje morgon.");
    expect(text.startsWith(teaser(text))).toBe(true);
  });
  it("returns a prefix of the story when a sentence holds an abbreviation like t.ex.", () => {
    const text = long("Vi serverar t.ex. fisk och skaldjur.");
    expect(text.startsWith(teaser(text))).toBe(true);
  });
  it("returns a prefix of the story when a sentence holds 'kl. 12'", () => {
    const text = long("Lunchen öppnar kl. 12 varje dag.");
    expect(text.startsWith(teaser(text))).toBe(true);
  });
  it("does not leave the story's start out when there is no full stop at all", () => {
    const text = "Ord ".repeat(100);
    expect(text.trim().startsWith(teaser(text).replace(/…$/, ""))).toBe(true);
  });
  it("copes with an ellipsis character inside the text", () => {
    const text = long("Vi väntar… och lagar maten långsamt.");
    expect(text.startsWith(teaser(text))).toBe(true);
  });
  it("never returns more than max, for empty and whitespace-only input too", () => {
    expect(teaser("")).toBe("");
    expect(teaser("   \n ")).toBe("");
    expect(teaser("x".repeat(500)).length).toBeLessThanOrEqual(220);
  });
});
