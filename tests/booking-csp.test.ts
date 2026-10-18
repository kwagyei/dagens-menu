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
  ];
  it.each(bad)("refuses %s", (_, code, problem) => {
    const result = embedProvider(code);
    expect("problem" in result && result.problem).toContain(problem);
    expect(checkedEmbed(code)).toBe("");
  });

  it("accepts a provider's script with its widget markup and a fallback link elsewhere", () => {
    const code = `<script src="https://www.formitable.com/sdk/v1.js"></script><div data-formitable-widget="abc"></div><a href="https://formitable.com">Boka</a>`;
    expect(embedProvider(code)).toMatchObject({ id: "formitable" });
    expect(checkedEmbed(code)).toBe(code);
  });
});
