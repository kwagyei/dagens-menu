/**
 * Every text colour in each site's theme is readable on the ground it sits on (WCAG AA, 4.5:1
 * for body text; identity pass, 19 Oct). The pairs follow site.css: which colour each look
 * puts on which background.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/content/contrast";

describe("contrastRatio", () => {
  it.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#777777", "#ffffff", 4.48],
    ["#12394A", "#fffdfb", 12.1],
  ])("%s on %s is %s", (a, b, ratio) => {
    expect(contrastRatio(a, b)).toBeCloseTo(ratio, 1);
    expect(contrastRatio(b, a)).toBeCloseTo(ratio, 1);
  });

  it("refuses a colour it can't read", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow(/rrggbb/);
  });
});

type Colours = Record<string, string>;
const sites = readdirSync(new URL("../sites/", import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`../sites/${d.name}/theme.json`, import.meta.url)))
  .map((d) => d.name);
const themes = sites.map((site) => ({
  site,
  ...(JSON.parse(readFileSync(new URL(`../sites/${site}/theme.json`, import.meta.url), "utf-8")) as { style: string; colors: Colours }),
}));

/** [text, background, where] for what each look sets in site.css. */
function pairs(style: string): [string, string, string][] {
  const common: [string, string, string][] = [
    ["text", "background", "body text"],
    ["text", "surface", "text on panels"],
    ["textMuted", "background", "descriptions"],
    ["textMuted", "surface", "descriptions on panels"],
    ["heroText", "heroBg", "footer and hero"],
    ["heroMuted", "heroBg", "footer secondary text"],
  ];
  return style === "classic"
    ? [...common, ["accent", "background", "prices and eyebrows"], ["accent", "surface", "prices on the menu card"], ["background", "accent", "primary button"]]
    : [
        ...common,
        ["surface", "accent", "primary button"],
        ["background", "text", "badge, price pills"],
        ["background", "secondary", "story band heading, the sticker"],
        ["surface", "secondary", "story band text"],
      ];
}

describe.each(themes)("$site theme", ({ style, colors }) => {
  it.each(pairs(style))("%s on %s (%s) is at least 4.5:1", (fg, bg) => {
    expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });
});
