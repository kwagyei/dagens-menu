/** Tester, 19 Oct polish branch: no inline script source anywhere in src/, the CI inline-script parser, and the JSON-LD graph. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineScripts } from "../scripts/check-admin-scripts.mjs";
import { serializeJsonLd } from "../src/server/json-ld";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const astroFiles = walk(join(__dirname, "../src")).filter((f) => f.endsWith(".astro"));

describe("no .astro file can emit an inline script or handler (public CSP is script-src 'self')", () => {
  it.each(astroFiles.map((f) => [f.split("/src/")[1], readFileSync(f, "utf-8")]))("%s", (_, src) => {
    expect(src).not.toMatch(/is:inline/);
    expect(src).not.toMatch(/<script[^>]*define:vars/);
    expect(src).not.toMatch(/<script(?![^>]*(ld\+json|src=))[^>]*set:html/);
    expect(src).not.toMatch(/\son[a-z]+\s*=\s*["{]/i);
    expect(src).not.toMatch(/["']javascript:/i);
  });
});

describe("inlineScripts edge cases", () => {
  it.each([
    ["a script with a type=text/javascript", `<script type="text/javascript">x()</script>`],
    ["an empty inline script", `<script></script>`],
    ["data-src is not src", `<script data-src="a.js">x()</script>`],
    ["importmap", `<script type="importmap">{}</script>`],
    ["a live script after a comment", `<!-- c --><script>x()</script>`],
    ["capitalised tag", `<SCRIPT>x()</SCRIPT>`],
  ])("flags %s", (_, html) => expect(inlineScripts(html)).toHaveLength(1));

  it.each([
    ["ld+json with single quotes", `<script type='application/ld+json'>{}</script>`],
    ["a commented-out script", `<!-- <script>x()</script> -->`],
    ["an external module", `<script type="module" src="/_astro/Base.js"></script>`],
  ])("passes %s", (_, html) => expect(inlineScripts(html)).toEqual([]));

  it("documents a gap: an inline event handler is not an inline <script> and is not flagged", () => {
    expect(inlineScripts(`<button onclick="x()">a</button>`)).toEqual([]);
  });
});

describe("JSON-LD graph", () => {
  it("keeps </script> inert and valid inside @graph", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Restaurant", name: "</script><script>alert(1)</script>" },
        { "@type": "Menu", name: "A & B" },
      ],
    };
    const out = serializeJsonLd(graph);
    expect(out).not.toMatch(/<\/?script/i);
    expect(JSON.parse(out)).toEqual(graph);
  });
});
