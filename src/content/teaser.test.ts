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

describe("teaser never loses text at an inner full stop (tester, 18 Oct)", () => {
  const long = (start: string) => `${start} ${"Sedan kommer en mening som fyller ut texten långt förbi gränsen för hemsidan.".repeat(4)}`;

  it.each([
    ["a decimal", "Vi bakar bröd i 2.5 timmar varje morgon."],
    ["an abbreviation before a lowercase word", "Vi serverar t.ex. fisk från västkusten."],
    ["a time", "Vi öppnar kl. 12 varje dag i veckan."],
  ])("%s stays inside its sentence", (_name, first) => {
    expect(teaser(long(first), 120)).toBe(first);
  });

  it("is always the text's own beginning", () => {
    for (const text of [long("Vi bakar bröd i 2.5 timmar."), long("Bl.a. surdeg och t.ex. råg."), long("Hej!”Ja.” Nej.")]) {
      const out = teaser(text, 90).replace(/…$/, "");
      expect(text.startsWith(out)).toBe(true);
    }
  });
});
