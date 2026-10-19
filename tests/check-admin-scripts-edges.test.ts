/**
 * Review L2, 18 Oct (tester, 19 Oct): the CI admin-script check against tricky HTML.
 * The four gaps the tester found (a data-type attribute, `</script >`, a commented-out admin
 * script, AdminLayout only in a query string) are closed; their tests now pass outright.
 */
import { describe, expect, it } from "vitest";
import { checkAdminScripts } from "../scripts/check-admin-scripts.mjs";

const external = `<script type="module" src="/_astro/AdminLayout.astro_astro_type_script_index_0_lang.Bx1.js"></script>`;

describe("finds the external admin script however it is written", () => {
  it.each([
    ["SRC in capitals", `<script type="module" SRC="/_astro/AdminLayout.x.js"></script>`],
    ["SCRIPT in capitals", `<SCRIPT type="module" src="/_astro/AdminLayout.x.js"></SCRIPT>`],
    ["a tab before src", `<script\tsrc="/_astro/AdminLayout.x.js"></script>`],
    ["a newline before src", `<script\nsrc="/_astro/AdminLayout.x.js"></script>`],
    ["an unquoted src", `<script type=module src=/_astro/AdminLayout.x.js></script>`],
  ])("%s", (_, html) => expect(checkAdminScripts(html)).toEqual([]));
});

describe("flags an inline script", () => {
  it.each([
    ["an empty one", `${external}<script></script>`],
    ["data-src is not src", `${external}<script data-src="x.js">run()</script>`],
    ["type=importmap", `${external}<script type="importmap">{}</script>`],
    ["an inline one beside a commented-out file", `<!-- ${external} --><script>run()</script>`],
  ])("%s", (_, html) => expect(checkAdminScripts(html).some((p) => /inline/.test(p))).toBe(true));

  it("ignores a script tag inside a comment: it never runs", () => {
    expect(checkAdminScripts(`${external}<!-- <script>run()</script> -->`)).toEqual([]);
  });

  it("errs on the side of failing: type=text/plain is flagged though it never runs", () => {
    expect(checkAdminScripts(`${external}<script type="text/plain">x</script>`)).toHaveLength(1);
  });
});

describe("known gaps (tester, 19 Oct)", () => {
  it("a data-type=application/json attribute should not exempt an inline script", () => {
    expect(checkAdminScripts(`${external}<script data-type="application/json">run()</script>`)).not.toEqual([]);
  });

  it("an end tag with a space (</script >) should still close an inline script", () => {
    expect(checkAdminScripts(`${external}<script>run()</script >`)).not.toEqual([]);
  });

  it("an admin script only inside an HTML comment should not count as loaded", () => {
    expect(checkAdminScripts(`<!-- ${external} -->`)).toContain("no external AdminLayout script");
  });

  it("AdminLayout in a query string, not the file name, should not count", () => {
    expect(checkAdminScripts(`<script type="module" src="/x.js?AdminLayout"></script>`)).toContain("no external AdminLayout script");
  });
});
