/**
 * Admin messages: every fill() call names exactly the placeholders its sv and en
 * string contain, no placeholder string is shown without fill(), and the quiet admin button's
 * fixed border holds 3:1 on every theme.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/content/contrast";
import en from "../src/i18n/en";
import sv from "../src/i18n/sv";

const placeholders = (s: string) => [...s.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|astro)$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
  });
const sources = files("src").map((p) => ({ p, text: readFileSync(p, "utf-8") }));

type Call = { file: string; key: string; keys: string[] };
const calls: Call[] = [];
for (const { p, text } of sources) {
  for (const m of text.matchAll(/fill\(\s*t\(\s*locale\s*,\s*"([^"]+)"\s*\)\s*,\s*\{/g)) {
    // read the balanced object literal after the match
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (depth > 0 && i < text.length) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    const body = text.slice(start, i - 1);
    // top-level keys only: strip nested {...}/(...) groups
    let flat = body;
    for (let n = 0; n < 5; n++) flat = flat.replace(/\([^()]*\)|\{[^{}]*\}|\[[^\][]*\]|"[^"]*"|`[^`]*`/g, "");
    const keys = flat
      .split(",")
      .map((s) => s.trim().split(":")[0].trim())
      .filter(Boolean)
      .sort();
    calls.push({ file: p, key: m[1], keys });
  }
}

describe("fill() call sites match the strings", () => {
  it("finds the migrated calls", () => expect(calls.length).toBeGreaterThanOrEqual(28));

  it.each(calls.map((c) => [`${c.file} ${c.key}`, c] as const))("%s", (_n, c) => {
    expect(Object.hasOwn(sv, c.key), `sv lacks ${c.key}`).toBe(true);
    expect(c.keys).toEqual(placeholders((sv as Record<string, string>)[c.key]));
    expect(c.keys).toEqual(placeholders((en as Record<string, string>)[c.key]));
  });

  it("sv and en use the same placeholder names for every key", () => {
    for (const [k, v] of Object.entries(sv)) expect(placeholders((en as Record<string, string>)[k] ?? ""), k).toEqual(placeholders(v));
  });
});

describe("no placeholder string reaches a page unfilled", () => {
  // Keys with placeholders that are filled elsewhere: the upload script substitutes in the browser.
  const clientFilled = new Set(["admin.photos.preparing"]);
  const withPlaceholders = Object.entries(sv)
    .filter(([, v]) => placeholders(v).length > 0)
    .map(([k]) => k);
  it.each(withPlaceholders)("%s is only used through fill()", (key) => {
    if (clientFilled.has(key)) return;
    let uses = 0;
    for (const { text } of sources) {
      for (const m of text.matchAll(new RegExp(`t\\(\\s*\\w+\\s*,\\s*"${key.replace(/\./g, "\\.")}"`, "g"))) {
        uses++;
        expect(text.slice(Math.max(0, m.index! - 12), m.index), `${key} used without fill()`).toMatch(/fill\(\s*$/);
      }
    }
    expect(uses, `${key} is never used`).toBeGreaterThan(0);
  });
});

describe("admin quiet button border", () => {
  const css = readFileSync("src/layouts/AdminLayout.astro", "utf-8");
  const border = /\.admin-button-quiet\s*\{[^}]*border:\s*1px solid (#[0-9a-f]{6})/i.exec(css)?.[1];
  it("is a fixed colour", () => expect(border).toBe("#6b6b6b"));
  for (const site of ["bistro", "westafrican"]) {
    const colors = JSON.parse(readFileSync(join("sites", site, "theme.json"), "utf-8")).colors as Record<string, string>;
    for (const name of ["background", "surface", "surfaceAlt"]) {
      it(`${site} ${name}: at least 3:1`, () => expect(contrastRatio(border!, colors[name])).toBeGreaterThanOrEqual(3));
    }
  }
});
