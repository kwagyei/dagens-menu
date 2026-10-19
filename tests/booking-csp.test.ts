/**
 * Booking and map embeds (H2, security review M1): embed code must frame exactly one known
 * provider in a sandboxed <iframe>, and a public page's CSP then allows that provider's
 * origins and the map's as frames, and nothing else. No provider ever gets script-src: the
 * admin shares the site's origin. The admin's policy never widens.
 */
import { describe, expect, it } from "vitest";
import { checkedEmbed, embedProvider, SANDBOX, thirdPartyOrigins } from "../src/booking/embed";
import { listPresets } from "../src/booking/presets";
import { securityHeaders } from "../src/server/http";

/** A preset's sample embed with its placeholder id filled in. */
const sample = (pattern: string) => pattern.replace(/RESTAURANT_(ID|UUID)/g, "abc123");
const embedPresets = Object.entries(listPresets()).filter(([, p]) => p.mode === "embed");
/** Every embed preset as an iframe of its first origin: what an operator pastes for each. */
const framed = embedPresets.map(([id, p]) => [id, p, p.embedPattern ? sample(p.embedPattern) : `<iframe src="${p.origins[0]}/book/abc123"></iframe>`] as const);
const sandboxed = (code: string) => code.replace(/<iframe ([^>]*)>/g, `<iframe $1 sandbox="${SANDBOX}">`);

/** The CSP as a map of directive → sources. */
function csp(headers: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(
    headers["Content-Security-Policy"].split(";").map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

const ALL_PROVIDER_ORIGINS = embedPresets.flatMap(([, p]) => p.origins);

describe("CSP per booking preset", () => {
  it.each(framed)("%s: allows its own origins as frames, and no other provider's", (id, preset, embedCode) => {
    const settings = { booking: { provider: "embed", embedCode }, mapEmbed: "" };
    expect(embedProvider(embedCode)).toMatchObject({ id });
    const policy = csp(securityHeaders("public", thirdPartyOrigins(settings)));
    for (const origin of preset.origins) expect(policy["frame-src"]).toContain(origin);
    for (const other of ALL_PROVIDER_ORIGINS.filter((o) => !preset.origins.includes(o))) expect(policy["frame-src"]).not.toContain(other);
    // Never anything that would let a provider run or fetch on the site's own origin.
    for (const directive of ["script-src", "connect-src", "style-src", "img-src"]) {
      expect(policy[directive].filter((s) => s.includes("://"))).toEqual([]);
    }
    expect(policy["default-src"]).toEqual(["'self'"]);
  });

  it("allows no third party at all when the site has no embed or map", () => {
    const policy = csp(securityHeaders("public", thirdPartyOrigins({ booking: { provider: "none" }, mapEmbed: "" })));
    const sources = Object.values(policy).flat();
    expect(sources.filter((s) => s.startsWith("https:") || s.includes("://"))).toEqual([]);
  });

  it("allows nothing for embed code that a link-mode site still carries", () => {
    const embedCode = sample(listPresets().thefork.embedPattern!);
    expect(thirdPartyOrigins({ booking: { provider: "link", embedCode }, mapEmbed: "" }).booking).toEqual([]);
  });

  it("allows the map's origin as a frame only", () => {
    const policy = csp(securityHeaders("public", thirdPartyOrigins({ booking: { provider: "none" }, mapEmbed: "https://www.google.com/maps/embed?pb=x" })));
    expect(policy["frame-src"]).toEqual(["'self'", "https://www.google.com"]);
    expect(policy["script-src"]).not.toContain("https://www.google.com");
  });

  it("never widens the admin's policy", () => {
    const origins = { booking: ["https://widget.thefork.com"], map: ["https://www.google.com"] };
    for (const route of ["admin", "admin-upload"] as const) {
      expect(securityHeaders(route, origins)["Content-Security-Policy"]).not.toMatch(/thefork|google/);
    }
  });
});

describe("embed code checks", () => {
  const FORK = `<iframe src="https://widget.thefork.com/x"></iframe>`;
  const bad: Array<[string, string, string]> = [
    ["a provider's script, even a known one (M1)", `<script src="https://app.waiteraid.com/w.js"></script>`, "only in its own <iframe>"],
    ["a provider's stylesheet", `<link rel="stylesheet" href="https://widget.thefork.com/x.css">${FORK}`, "may not contain <link>"],
    ["an unknown host", `<iframe src="https://evil.example/w"></iframe>`, "one known booking provider"],
    ["two providers at once", `<iframe src="https://app.waiteraid.com/w"></iframe>${FORK}`, "one known booking provider"],
    ["inline script", `<script>alert(1)</script>`, "<script>"],
    ["inline script beside a provider", `${FORK}<script>steal()</script>`, "<script>"],
    ["an event handler", `<iframe src="https://widget.thefork.com/x" onload="steal()"></iframe>`, "event handlers"],
    ["its own sandbox, which could loosen ours", `<iframe src="https://widget.thefork.com/x" sandbox="allow-top-navigation"></iframe>`, "sandbox attribute"],
    ["plain http", `<iframe src="http://widget.thefork.com/x"></iframe>`, "https://"],
    ["a protocol-relative URL", `<iframe src="//widget.thefork.com/x"></iframe>`, "https://"],
    ["a tag the CSP isn't built for", `<img src="https://widget.thefork.com/p.gif">`, "<img>"],
    ["no provider at all", `<div data-x="1"></div>`, "must frame"],
    ["a closing tag for the page's own <template>", `</template>${FORK}`, "closes nothing"],
    ["a comment", `<!-- x -->${FORK}`, "can't read"],
    ["a self-closed div the browser leaves open", `<div/>${FORK}`, "self-close"],
    ["an element left open", `<div>${FORK}`, "leaves <div> open"],
    ["text inside an iframe", `<iframe src="https://widget.thefork.com/x"><p>x</p></iframe>`, "empty"],
    ["srcdoc", `<iframe src="https://widget.thefork.com/x" srcdoc="&lt;script&gt;x()&lt;/script&gt;"></iframe>`, "srcdoc"],
    ["a style that loads", `<div style="background:url(https://evil.example/x.png)"></div>${FORK}`, "style attribute"],
    ["a src with user info", `<iframe src="https://widget.thefork.com@evil.example/"></iframe>`, "https://"],
    ["a powerful feature handed to the provider", `<iframe src="https://widget.thefork.com/x" allow="usb *"></iframe>`, "may not grant usb"],
    ["screen capture beside payment", `<iframe src="https://widget.thefork.com/x" allow="payment *; display-capture"></iframe>`, "may not grant display-capture"],
    ["an allow origin it can't read", `<iframe src="https://widget.thefork.com/x" allow="payment javascript:x"></iframe>`, "can't read"],
    ["noscript, which the browser reads as text", `<noscript><img src="https://evil.example/p.gif"></noscript>${FORK}`, "<noscript>"],
  ];
  it.each(bad)("refuses %s", (_, code, problem) => {
    const result = embedProvider(code);
    expect("problem" in result && result.problem).toContain(problem);
    expect(checkedEmbed(code)).toBe("");
  });

  it.each(framed)("%s: accepts its iframe and serializes it with the page's own sandbox", (_, _preset, code) => {
    expect(checkedEmbed(code)).toBe(sandboxed(code));
  });

  it("no preset's example is a script", () => {
    for (const [, preset] of embedPresets) expect(preset.embedPattern ?? "").not.toMatch(/<script/i);
  });

  it("gives the page its own serialization: entities decoded once, then escaped again", () => {
    const code = `<p title='a "b"'>Fisk &amp; chips &lt;3</p><iframe SRC="https://widget.thefork.com/x?a=1&amp;b=2" allowfullscreen></iframe>`;
    expect(checkedEmbed(code)).toBe(
      `<p title="a &quot;b&quot;">Fisk &amp; chips &lt;3</p><iframe src="https://widget.thefork.com/x?a=1&amp;b=2" allowfullscreen sandbox="${SANDBOX}"></iframe>`,
    );
  });

  it("checks a URL as the browser will read it, after its character references", () => {
    expect(embedProvider(`<iframe src="https&#58;//evil.example/x"></iframe>`)).toMatchObject({ problem: expect.stringContaining("one known booking provider") });
    expect(embedProvider(`<a href="&#x6a;avascript:alert(1)">x</a><iframe src="https://widget.thefork.com/x"></iframe>`)).toMatchObject({
      problem: expect.stringContaining("https://"),
    });
  });

  it("accepts a provider's frame with wrapper markup and a fallback link elsewhere", () => {
    const code = `<div class="booking"><iframe src="https://www.formitable.com/book/abc" title="Boka"></iframe></div><a href="https://formitable.com">Boka</a>`;
    expect(embedProvider(code)).toMatchObject({ id: "formitable" });
    expect(checkedEmbed(code)).toBe(sandboxed(code));
  });
});
