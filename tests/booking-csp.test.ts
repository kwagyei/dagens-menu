/**
 * Booking and map embeds (H2): embed code must load from exactly one known provider, and a
 * public page's CSP then allows that provider's origins, the map's origin as a frame, and
 * nothing else. The admin's policy never widens.
 */
import { describe, expect, it } from "vitest";
import { checkedEmbed, embedProvider, thirdPartyOrigins } from "../src/booking/embed";
import { listPresets } from "../src/booking/presets";
import { securityHeaders } from "../src/server/http";

/** A preset's sample embed with its placeholder id filled in. */
const sample = (pattern: string) => pattern.replace(/RESTAURANT_(ID|UUID)/g, "abc123");
const embedPresets = Object.entries(listPresets()).filter(([, p]) => p.mode === "embed");

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
  it.each(embedPresets)("%s: allows its own origins and no other provider's", (id, preset) => {
    const settings = { booking: { provider: "embed", embedCode: sample(preset.embedPattern!) }, mapEmbed: "" };
    expect(embedProvider(settings.booking.embedCode)).toMatchObject({ id });
    const policy = csp(securityHeaders("public", thirdPartyOrigins(settings)));
    for (const directive of ["script-src", "frame-src", "connect-src", "style-src", "img-src"]) {
      for (const origin of preset.origins) expect(policy[directive]).toContain(origin);
      for (const other of ALL_PROVIDER_ORIGINS.filter((o) => !preset.origins.includes(o))) expect(policy[directive]).not.toContain(other);
    }
    expect(policy["default-src"]).toEqual(["'self'"]);
  });

  it("allows no third party at all when the site has no embed or map", () => {
    const policy = csp(securityHeaders("public", thirdPartyOrigins({ booking: { provider: "none" }, mapEmbed: "" })));
    const sources = Object.values(policy).flat();
    expect(sources.filter((s) => s.startsWith("https:") || s.includes("://"))).toEqual([]);
  });

  it("allows nothing for embed code that a link-mode site still carries", () => {
    const embedCode = sample(listPresets().waiteraid.embedPattern!);
    expect(thirdPartyOrigins({ booking: { provider: "link", embedCode }, mapEmbed: "" }).booking).toEqual([]);
  });

  it("allows the map's origin as a frame only", () => {
    const policy = csp(securityHeaders("public", thirdPartyOrigins({ booking: { provider: "none" }, mapEmbed: "https://www.google.com/maps/embed?pb=x" })));
    expect(policy["frame-src"]).toEqual(["'self'", "https://www.google.com"]);
    expect(policy["script-src"]).not.toContain("https://www.google.com");
  });

  it("never widens the admin's policy", () => {
    const origins = { booking: ["https://app.waiteraid.com"], map: ["https://www.google.com"] };
    for (const route of ["admin", "admin-upload"] as const) {
      expect(securityHeaders(route, origins)["Content-Security-Policy"]).not.toMatch(/waiteraid|google/);
    }
  });
});

describe("embed code checks", () => {
  const bad: Array<[string, string, string]> = [
    ["an unknown host", `<script src="https://evil.example/w.js"></script>`, "one known booking provider"],
    ["two providers at once", `<script src="https://app.waiteraid.com/w.js"></script><iframe src="https://widget.thefork.com/x"></iframe>`, "one known booking provider"],
    ["inline script", `<script>alert(1)</script>`, "inline script"],
    ["inline script beside a provider", `<script src="https://app.waiteraid.com/w.js"></script><script>steal()</script>`, "inline script"],
    ["an event handler", `<iframe src="https://widget.thefork.com/x" onload="steal()"></iframe>`, "event handlers"],
    ["plain http", `<script src="http://app.waiteraid.com/w.js"></script>`, "https://"],
    ["a protocol-relative URL", `<script src="//app.waiteraid.com/w.js"></script>`, "https://"],
    ["a tag the CSP isn't built for", `<img src="https://app.waiteraid.com/p.gif">`, "<img>"],
    ["no provider at all", `<div data-x="1"></div>`, "must load"],
    ["a closing tag for the page's own <template>", `</template><script src="https://app.waiteraid.com/w.js"></script>`, "closes nothing"],
    ["a comment", `<!-- x --><script src="https://app.waiteraid.com/w.js"></script>`, "can't read"],
    ["a self-closed div the browser leaves open", `<div/><script src="https://app.waiteraid.com/w.js"></script>`, "self-close"],
    ["an element left open", `<div><script src="https://app.waiteraid.com/w.js"></script>`, "leaves <div> open"],
    ["text inside an iframe", `<iframe src="https://widget.thefork.com/x"><p>x</p></iframe>`, "empty"],
    ["srcdoc", `<iframe src="https://widget.thefork.com/x" srcdoc="&lt;script&gt;x()&lt;/script&gt;"></iframe>`, "srcdoc"],
    ["a link that isn't a stylesheet", `<link rel="preload" href="https://www.formitable.com/x.js"><script src="https://www.formitable.com/sdk/v1.js"></script>`, "stylesheet"],
    ["a style that loads", `<div style="background:url(https://evil.example/x.png)"></div><script src="https://app.waiteraid.com/w.js"></script>`, "style attribute"],
    ["a src with user info", `<iframe src="https://widget.thefork.com@evil.example/"></iframe>`, "https://"],
    ["noscript, which the browser reads as text", `<noscript><img src="https://evil.example/p.gif"></noscript><script src="https://app.waiteraid.com/w.js"></script>`, "<noscript>"],
  ];
  it.each(bad)("refuses %s", (_, code, problem) => {
    const result = embedProvider(code);
    expect("problem" in result && result.problem).toContain(problem);
    expect(checkedEmbed(code)).toBe("");
  });

  it.each(embedPresets)("%s: accepts its own sample embed and serializes it unchanged", (_, preset) => {
    const code = sample(preset.embedPattern!);
    expect(checkedEmbed(code)).toBe(code.replace(/allow="payment \*"/, 'allow="payment *"'));
  });

  it("gives the page its own serialization: entities decoded once, then escaped again", () => {
    const code = `<p title='a "b"'>Fisk &amp; chips &lt;3</p><iframe SRC="https://widget.thefork.com/x?a=1&amp;b=2" allowfullscreen></iframe>`;
    expect(checkedEmbed(code)).toBe(
      `<p title="a &quot;b&quot;">Fisk &amp; chips &lt;3</p><iframe src="https://widget.thefork.com/x?a=1&amp;b=2" allowfullscreen></iframe>`,
    );
  });

  it("checks a URL as the browser will read it, after its character references", () => {
    expect(embedProvider(`<script src="https&#58;//evil.example/x.js"></script>`)).toMatchObject({ problem: expect.stringContaining("one known booking provider") });
    expect(embedProvider(`<a href="&#x6a;avascript:alert(1)">x</a><script src="https://app.waiteraid.com/w.js"></script>`)).toMatchObject({ problem: expect.stringContaining("https://") });
  });

  it("accepts a provider's script with its widget markup and a fallback link elsewhere", () => {
    const code = `<script src="https://www.formitable.com/sdk/v1.js"></script><div data-formitable-widget="abc"></div><a href="https://formitable.com">Boka</a>`;
    expect(embedProvider(code)).toMatchObject({ id: "formitable" });
    expect(checkedEmbed(code)).toBe(code);
  });
});
