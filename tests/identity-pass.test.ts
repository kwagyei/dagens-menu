/**
 * Tester checks for the identity-pass branch (19 Oct): colour pairs site.css draws that
 * tests/theme-contrast.test.ts does not list, localityOf with odd addresses, and leftovers of
 * the removed squiggle. The four bugs it found are fixed, and their tests pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/content/contrast";
import { localityOf } from "../src/content/locality";

const theme = (site: string) => JSON.parse(readFileSync(`sites/${site}/theme.json`, "utf-8")).colors as Record<string, string>;
const bistro = theme("bistro");
const abena = theme("westafrican");

/** The linen weave lays up to ~5 % of the text colour over the background (site.css). */
function linen(c: Record<string, string>): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return (
    "#" +
    [1, 3, 5]
      .map((i) =>
        Math.round(ch(c.text, i) * 0.052 + ch(c.background, i) * 0.948)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

describe("classic: pairs on the linen card and elsewhere", () => {
  const onLinen = linen(bistro);
  it.each(["text", "textMuted", "accent", "primary"])("%s on the linen weave is at least 4.5:1", (fg) => {
    expect(contrastRatio(bistro[fg], onLinen)).toBeGreaterThanOrEqual(4.5);
  });
  it("the marked category (primary on background) is at least 4.5:1", () => {
    expect(contrastRatio(bistro.primary, bistro.background)).toBeGreaterThanOrEqual(4.5);
  });
  it("the accent focus ring and the underline are at least 3:1 on the page", () => {
    expect(contrastRatio(bistro.accent, bistro.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(bistro.accent, onLinen)).toBeGreaterThanOrEqual(3);
  });
  it("text on surface, used by the voice band and plain dish tiles", () => {
    expect(contrastRatio(bistro.text, bistro.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("modern: pairs the base test leaves out", () => {
  it.each([
    ["text", "background", 4.5],
    ["text", "surface", 4.5],
    ["accent", "surface", 4.5],
    ["heroText", "text", 4.5], // the open menu panel
    ["heroMuted", "text", 4.5],
    ["background", "heroBg", 4.5], // footer name
    ["text", "background", 3], // focus ring on the page
    ["secondary", "background", 3], // the ring motif's edge against the cloth
  ])("%s on %s is at least %s:1", (fg, bg, min) => {
    expect(contrastRatio(abena[fg], abena[bg])).toBeGreaterThanOrEqual(min);
  });

  // .star:focus-visible inverts the sticker: fill secondary -> background, text background ->
  // secondary. The change and the focused text must both clear 3:1 (it was 1.2:1 before the fix).
  it("the sticker's focus state differs from its resting state by at least 3:1", () => {
    expect(contrastRatio(abena.secondary, abena.background)).toBeGreaterThanOrEqual(3);
  });
});

describe("localityOf: odd addresses", () => {
  it.each([
    ["Box 123, 111 51 Stockholm", "Stockholm"],
    ["c/o Anna Svensson, Storgatan 12, 111 51 Stockholm", "Stockholm"],
    ["Storgatan 12,111 51 Stockholm", "Stockholm"],
    ["Storgatan 12, 111 51 Stockholm", "Stockholm"],
    ["111 51 Stockholm", "Stockholm"],
    ["Storgatan 12, 111 51 STOCKHOLM", "STOCKHOLM"],
    ["Storgatan 12\n111 51 Stockholm", "Stockholm"],
    ["Storgatan 12, 111 51 Västra Frölunda", "Västra Frölunda"],
    ["Storgatan 12, 111 51 Sankt-Olofs", "Sankt-Olofs"],
  ])("%j gives %j", (address, town) => {
    expect(localityOf(address)).toBe(town);
  });

  it.each([
    ["Storgata 1, 0150 Oslo"], // Norwegian: four digits, so no eyebrow rather than "0150 Oslo"
    ["Vestergade 1, DK-1456 København K"],
    ["Storgatan 12 111 51 Stockholm"], // no comma at all
    ["Storgatan 12, Stockholm 111 51"],
    ["   "],
  ])("shows no town for %j", (address) => {
    expect(localityOf(address)).toBeNull();
  });

  // Known gaps, medium-low: a trailing country or a trailing comma, and a street with no number.
  it("ignores a trailing country: 'Storgatan 12, 111 51 Stockholm, Sverige' gives Stockholm", () => {
    expect(localityOf("Storgatan 12, 111 51 Stockholm, Sverige")).toBe("Stockholm");
  });
  it("ignores a trailing comma", () => {
    expect(localityOf("Storgatan 12, 111 51 Stockholm,")).toBe("Stockholm");
  });
  it("a street name alone is not a town", () => {
    expect(localityOf("Strandvägen")).toBeNull();
  });
});

describe("the squiggle is gone from the source", () => {
  const dirs = ["src/components", "src/pages"];
  const files = dirs.flatMap((d) =>
    readdirSync(d, { recursive: true, encoding: "utf-8" })
      .filter((f) => f.endsWith(".astro"))
      .map((f) => `${d}/${f}`),
  );
  it.each(files)("%s has no squiggle path", (file) => {
    expect(readFileSync(file, "utf-8")).not.toMatch(/squiggle|M3 12 q 6\.5/);
  });
  it("site.css has no rule for it, or for Cormorant", () => {
    expect(readFileSync("src/styles/site.css", "utf-8")).not.toMatch(/squiggle|Cormorant/);
  });
});
