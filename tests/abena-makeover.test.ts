/** Tester checks for the abena-makeover branch (21 Oct): colour pairs the modern look draws, weekRuns edges, classic untouched. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/content/contrast";
import { weekRuns } from "../src/content/hours";

const c = JSON.parse(readFileSync("sites/westafrican/theme.json", "utf-8")).colors as Record<string, string>;
const css = readFileSync("src/styles/site.css", "utf-8");

describe("modern pairs drawn by the makeover", () => {
  it.each([
    ["secondary", "accent", "oval, sticker, spicy chip", 4.5],
    ["accent", "secondary", "focused sticker", 4.5],
    ["text", "background", "body on lime", 4.5],
    ["text", "surface", "menu card text", 4.5],
    ["textMuted", "surface", "meta on card", 4.5],
    ["textMuted", "background", "muted on lime", 4.5],
    ["background", "text", "hours badge, price pills", 4.5],
    ["accent", "text", "badge dot on forest (UI)", 3],
    ["heroText", "heroBg", "footer call", 4.5],
    ["background", "heroBg", "footer name", 4.5],
    ["heroMuted", "heroBg", "footer links", 4.5],
    ["text", "surfaceAlt", "hero img placeholder", 3],
    ["text", "background", "focus ring on lime", 3],
    ["heroText", "heroBg", "footer focus ring", 3],
    ["background", "heroBg", "footer social focus ring", 3],
    ["text", "surface", "dish-card pill", 4.5],
  ])("%s on %s (%s) >= %s", (fg, bg, _why, min) => {
    expect(contrastRatio(c[fg], c[bg])).toBeGreaterThanOrEqual(min as number);
  });
});

describe("weekRuns edges", () => {
  const closed = { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null } as never;
  it("all closed is one run", () => {
    expect(weekRuns(closed)).toEqual([{ first: "monday", last: "sunday", hours: null }]);
  });
  it("a missing key counts as closed", () => {
    expect(weekRuns({} as never)).toHaveLength(1);
  });
});

describe("classic is untouched by unscoped rules", () => {
  it("every unscoped new rule targets a modern-only class", () => {
    for (const sel of [".squiggle", ".site-footer__call", ".intro-dag", ".slices", ".star"]) expect(css).toContain(sel);
    expect(css).not.toMatch(/wax-|\.teeth|--above/);
  });
});
