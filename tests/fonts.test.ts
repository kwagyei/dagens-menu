/**
 * The self-hosted fonts stay small, licensed and local (identity pass, 19 Oct): every woff2 in
 * public/fonts is within budget and named in OFL.txt, and every @font-face loads a file that
 * exists here, never from another host, with font-display: swap.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FONTS = new URL("../public/fonts/", import.meta.url);
const BUDGET = 40 * 1024;
const files = readdirSync(FONTS).filter((f) => f.endsWith(".woff2"));
const licence = readFileSync(new URL("OFL.txt", FONTS), "utf-8");
const css = ["global.css", "site.css"].map((f) => readFileSync(new URL(`../src/styles/${f}`, import.meta.url), "utf-8")).join("\n");
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);

describe("self-hosted fonts", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(faces.length).toBeGreaterThan(0);
  });

  it.each(files)("%s is within the 40 kB budget", (file) => {
    expect(statSync(new URL(file, FONTS)).size).toBeLessThanOrEqual(BUDGET);
  });

  it.each(files)("%s is named in OFL.txt, with its copyright", (file) => {
    expect(licence).toContain(file);
  });

  it("every @font-face loads a local file that exists, with font-display: swap", () => {
    for (const face of faces) {
      const src = /url\("([^"]+)"\)/.exec(face)?.[1] ?? "";
      expect(src, face).toMatch(/^\/fonts\/[\w-]+\.woff2$/);
      expect(existsSync(new URL(src.slice("/fonts/".length), FONTS)), src).toBe(true);
      expect(face, src).toMatch(/font-display:\s*swap/);
    }
  });

  it("every font file is used by an @font-face", () => {
    for (const file of files) expect(css, file).toContain(`/fonts/${file}`);
  });
});
