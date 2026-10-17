/**
 * The old Cloudflare Pages demos are deployed from pages-redirect/<site>/ and must do one thing:
 * send every path, with its rest intact, to that site's Worker with a 301 (ADR-011 plan M7.2).
 * Anything else in the folder would be served from pages.dev again.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SITES = ["bistro", "westafrican"];

describe.each(SITES)("pages-redirect/%s", (site) => {
  const dir = `pages-redirect/${site}`;

  it("holds only the _redirects file", () => {
    expect(readdirSync(dir)).toEqual(["_redirects"]);
  });

  it("redirects every path, permanently, to this site's Worker", () => {
    const worker = JSON.parse(
      readFileSync(`wrangler.${site}.jsonc`, "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as { name: string };
    const lines = readFileSync(`${dir}/_redirects`, "utf8").split("\n").filter((l) => l.trim());
    expect(lines).toEqual([`/* https://${worker.name}.kwabenasasuboakye.workers.dev/:splat 301`]);
  });
});
