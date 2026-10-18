/**
 * Security review M1, 18 Oct: pasted embed code can't loosen the sandbox the
 * page puts on every provider frame, can't frame anything but a known provider, and can't
 * carry a script-bearing link. Also checks the map iframe, which takes any https origin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { embedProvider, SANDBOX } from "../src/booking/embed";
import { securityHeaders } from "../src/server/http";

const SRC = "https://widget.thefork.com/abc";
const FRAME = `<iframe src="${SRC}"></iframe>`;
const refused = (code: string) => expect(embedProvider(code), code).toHaveProperty("problem");
const html = (code: string) => {
  const result = embedProvider(code);
  if (!("html" in result)) throw new Error(`refused: ${result.problem}`);
  return result.html;
};
/** The iframes as the browser will read the page's serialization. */
const sandboxesIn = (out: string) => [...out.matchAll(/<iframe\b[^>]*>/g)].map((m) => [...m[0].matchAll(/\ssandbox="([^"]*)"/g)].map((s) => s[1]));

describe("sandbox can't be set or loosened by pasted code", () => {
  it.each([
    ["uppercase", `<iframe src="${SRC}" SANDBOX="allow-top-navigation"></iframe>`],
    ["mixed case", `<iframe src="${SRC}" SandBox="allow-top-navigation"></iframe>`],
    ["tab and newline around =", `<iframe src="${SRC}"\tsandbox\n=\n"allow-top-navigation"></iframe>`],
    ["no-break space before the name", `<iframe src="${SRC}" sandbox="allow-top-navigation"></iframe>`],
    ["glued to the previous value", `<iframe src="${SRC}"sandbox="allow-top-navigation"></iframe>`],
    ["slash separator", `<iframe/sandbox="allow-top-navigation"/src="${SRC}"></iframe>`],
    ["empty sandbox, then src", `<iframe sandbox src="${SRC}"></iframe>`],
    ["duplicate src, second one elsewhere", `<iframe src="${SRC}" src="https://evil.example/"></iframe>`],
    ["duplicate src in another case", `<iframe src="${SRC}" SRC="https://evil.example/"></iframe>`],
    ["srcdoc", `<iframe src="${SRC}" srcdoc="<b>x</b>"></iframe>`],
    ["sandbox on a wrapper", `<div sandbox="allow-top-navigation">${FRAME}</div>`],
    ["an entity in the attribute name", `<iframe src="${SRC}" sand&#98;ox="allow-top-navigation"></iframe>`],
  ])("refuses %s", (_name, code) => refused(code));

  it.each([
    ["bare", FRAME],
    ["in a div", `<div class="booking">${FRAME}</div>`],
    ["deep in wrappers", `<div><p><span>${FRAME}</span></p></div>`],
    ["two frames of one provider", `${FRAME}<div>${FRAME}</div>`],
    ["with every allowed iframe attribute", `<iframe src="${SRC}" width="100%" height="800" allow="payment *" allowfullscreen loading="lazy" referrerpolicy="no-referrer" frameborder="0" scrolling="no" name="b" title="t"></iframe>`],
  ])("gives every frame exactly the page's sandbox: %s", (_name, code) => {
    const sandboxes = sandboxesIn(html(code));
    expect(sandboxes.length).toBeGreaterThan(0);
    for (const s of sandboxes) expect(s).toEqual([SANDBOX]);
  });

  it("the page's sandbox never lets the frame navigate the visitor's page", () => {
    expect(SANDBOX.split(/\s+/)).not.toContain("allow-top-navigation");
    expect(SANDBOX.split(/\s+/)).not.toContain("allow-top-navigation-by-user-activation");
    expect(SANDBOX.split(/\s+/)).not.toContain("allow-modals");
  });
});

describe("only a known provider's https origin can be framed", () => {
  it.each([
    ["the site's own origin", `<iframe src="https://bistro.example/admin/"></iframe>`],
    ["a relative path to the admin", `<iframe src="/admin/"></iframe>`],
    ["protocol-relative", `<iframe src="//widget.thefork.com/abc"></iframe>`],
    ["blob url", `<iframe src="blob:https://widget.thefork.com/1234"></iframe>`],
    ["data url in base64", `<iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>`],
    ["javascript url", `<iframe src="javascript:alert(1)"></iframe>`],
    ["http, not https", `<iframe src="http://widget.thefork.com/abc"></iframe>`],
    ["a lookalike host", `<iframe src="https://widget.thefork.com.evil.example/"></iframe>`],
    ["a backslash host trick", `<iframe src="https://evil.example\\@widget.thefork.com/"></iframe>`],
    ["another port", `<iframe src="https://widget.thefork.com:8443/abc"></iframe>`],
    ["no src", `<iframe title="x"></iframe>`],
    ["frames from two providers", `${FRAME}<iframe src="https://book.easytable.com/book/?id=1"></iframe>`],
  ])("refuses %s", (_name, code) => refused(code));
});

describe("links in embed code can't run script", () => {
  it.each([
    ["javascript href with target", `${FRAME}<a target="_top" href="javascript:alert(1)">x</a>`],
    ["mixed-case javascript", `${FRAME}<a href="JaVaScRiPt:alert(1)">x</a>`],
    ["leading space", `${FRAME}<a href=" javascript:alert(1)">x</a>`],
    ["tab inside the scheme, as an entity", `${FRAME}<a href="java&#9;script:alert(1)">x</a>`],
    ["newline inside the scheme", `${FRAME}<a href="java\nscript:alert(1)">x</a>`],
    ["vbscript", `${FRAME}<a href="vbscript:msgbox(1)">x</a>`],
    ["data url", `${FRAME}<a href="data:text/html,<script>alert(1)</script>">x</a>`],
    ["an event handler in upper case", `${FRAME}<a href="https://widget.thefork.com/" ONCLICK="alert(1)">x</a>`],
    ["formaction-like attributes", `${FRAME}<a href="https://widget.thefork.com/" ping="https://evil.example/">x</a>`],
  ])("refuses %s", (_name, code) => refused(code));
});

describe("what a provider frame may be granted (findings)", () => {
  /**
   * The `allow` attribute is passed through as pasted. The site's Permissions-Policy blocks
   * camera, microphone and geolocation for every frame, but not other powerful features, so
   * pasted code can delegate them to the provider's frame.
   */
  it("allow can't delegate a powerful feature the site's Permissions-Policy doesn't block", () => {
    const policy = securityHeaders("public")["Permissions-Policy"];
    const blocked = new Set([...policy.matchAll(/([a-z-]+)=\(\)/g)].map((m) => m[1]));
    const code = `<iframe src="${SRC}" allow="usb *; serial *; hid *; bluetooth *; display-capture *; clipboard-read *"></iframe>`;
    const result = embedProvider(code);
    if ("problem" in result) return; // refused: fine
    const delegated = (/\sallow="([^"]*)"/.exec(result.html)?.[1] ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(delegated.filter((f) => !blocked.has(f))).toEqual([]);
  });

  /** The map takes any https URL (operator field) and is framed without a sandbox. */
  it("the map iframe is sandboxed like the booking frame", () => {
    const source = readFileSync(new URL("../src/components/MapEmbed.astro", import.meta.url), "utf8");
    const iframe = /<iframe\b[^>]*>/.exec(source)?.[0] ?? "";
    expect(iframe).toMatch(/\ssandbox=/);
  });
});
