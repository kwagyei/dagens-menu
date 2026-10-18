/**
 * set:html bypasses Astro's escaping. Owners now type the text pages show, so every use must
 * go through an escaper, or for the operator's booking embed, the check its CSP is built from;
 * this test fails when a new one appears that doesn't.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const ALLOWED = [/set:html=\{serializeJsonLd\(/, /set:html=\{checkedEmbed\(/];

function* astroFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* astroFiles(path);
    else if (entry.name.endsWith(".astro")) yield path;
  }
}

it("uses set:html only through an escaping helper", () => {
  const unsafe: string[] = [];
  for (const file of astroFiles(SRC)) {
    for (const [index, line] of readFileSync(file, "utf-8").split("\n").entries()) {
      if (line.includes("set:html") && !ALLOWED.some((ok) => ok.test(line))) unsafe.push(`${file}:${index + 1}`);
    }
  }
  expect(unsafe).toEqual([]);
});
