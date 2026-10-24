/**
 * A photo slot's `sizes` must match how wide the CSS draws it, or browsers fetch the wrong file:
 * too small blurs, too large wastes data (21 Oct review M1: the portrait slot said 11rem after
 * the makeover had grown the circle). Reads both files, so a restyle that forgets one fails.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const photo = readFileSync(new URL("../src/components/Photo.astro", import.meta.url), "utf-8");
const css = readFileSync(new URL("../src/styles/site.css", import.meta.url), "utf-8");
const sizesOf = (slot: string) => new RegExp(`\\b${slot}: "([^"]+)"`).exec(photo)?.[1] ?? "";

describe("photo slot sizes follow the CSS", () => {
  it("portrait: the modern story circle's phone and desktop widths", () => {
    const sizes = sizesOf("portrait");
    const phone = /\[data-style="modern"\] \.home-story__photo \{ width: ([^;]+);/.exec(css)?.[1];
    // The desktop width and the breakpoint of the @media block it sits in, both read from the CSS.
    const wide = /@media \(min-width: ([\d.]+rem)\) \{[^@]*?\[data-style="modern"\] \.home-story__photo \{ width: (\d+rem); \}/.exec(css);
    expect(phone, "phone width in site.css").toBeTruthy();
    expect(wide, "desktop width and breakpoint in site.css").toBeTruthy();
    const [, breakpoint, desktop] = wide!;
    expect(sizes).toBe(`(min-width: ${breakpoint}) ${desktop}, ${phone}`);
  });
});
