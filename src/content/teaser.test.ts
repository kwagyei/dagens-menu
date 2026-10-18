import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { teaser } from "./teaser";

describe("teaser (the home page's opening of the About story)", () => {
  it("keeps a short text whole", () => {
    expect(teaser("Vi lagar mat.", 220)).toBe("Vi lagar mat.");
  });

  it("takes as many whole sentences as fit", () => {
    expect(teaser("Ett. Två är längre. Tre är mycket längre än de andra.", 25)).toBe("Ett. Två är längre.");
  });

  it("always gives at least the first sentence's start, cut at a word with an ellipsis", () => {
    const out = teaser("En mycket lång första mening utan slut som fortsätter och fortsätter och fortsätter", 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toMatch(/\s…$/);
  });

  it("handles ! and ? and a closing quote, and collapses whitespace", () => {
    expect(teaser("Hej!\n\n  Välkommen ”hem”. Sist kommer en lång mening som inte ryms här alls.", 25)).toBe("Hej! Välkommen ”hem”.");
  });

  it("gives both demos a teaser of one or more whole sentences, in both languages", () => {
    for (const site of ["bistro", "westafrican"]) {
      const story = JSON.parse(readFileSync(`sites/${site}/content/pages.json`, "utf-8")).about.story as Record<string, string>;
      for (const lang of ["sv", "en"]) {
        const out = teaser(story[lang]);
        expect(out.length, `${site} ${lang}`).toBeLessThanOrEqual(220);
        expect(out, `${site} ${lang}`).toMatch(/[.!?]$/);
        expect(story[lang].startsWith(out), `${site} ${lang}`).toBe(true);
      }
    }
  });
});
