/** The CI admin-script check's parser (scripts/check-admin-scripts.mjs, review L2). */
import { describe, expect, it } from "vitest";
import { checkAdminScripts, inlineScripts } from "../scripts/check-admin-scripts.mjs";

const external = `<script type="module" src="/_astro/AdminLayout.astro_astro_type_script_index_0_lang.Bx1.js"></script>`;

describe("checkAdminScripts", () => {
  it("accepts a page whose admin script is a file", () => {
    expect(checkAdminScripts(`<head>${external}<script type="module" src="/_astro/passkey.js"></script></head>`)).toEqual([]);
  });

  it("accepts JSON data in a script tag", () => {
    expect(checkAdminScripts(`${external}<script type="application/json">{"a":1}</script>`)).toEqual([]);
  });

  it("refuses an inlined script, which the admin's CSP would block", () => {
    const problems = checkAdminScripts(`${external}<script type="module">const run = () => {}</script>`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/inline <script type="module">/);
  });

  it("refuses a page with no external admin script: it was inlined, or it went missing", () => {
    expect(checkAdminScripts(`<script type="module">returnFocus()</script>`)).toEqual([expect.stringMatching(/inline/), "no external AdminLayout script"]);
  });
});

describe("inlineScripts (public pages, 19 Oct)", () => {
  it("passes a page with only external scripts and JSON-LD", () => {
    expect(inlineScripts(`<script type="application/ld+json">{"@type":"Restaurant"}</script><script type="module" src="/_astro/Base.js"></script>`)).toEqual([]);
  });

  it("refuses an inline module script, which the public CSP would now block", () => {
    expect(inlineScripts(`<script type="module">document.body.dataset.x = 1</script>`)).toHaveLength(1);
  });
});
