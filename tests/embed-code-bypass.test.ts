/** Attacks on embedProvider: embed code that runs script or loads outside the CSP's provider. */
import { describe, expect, it } from "vitest";
import { embedProvider, thirdPartyOrigins } from "../src/booking/embed";

const FORK = `<iframe src="https://widget.thefork.com/abc"></iframe>`;
const GOOD = FORK;
const refused = (code: string) => expect("problem" in embedProvider(code)).toBe(true);

describe("embedProvider refuses what would run or load outside the provider", () => {
  it.each([
    ["inline script closed by </script x>", `${GOOD}<script>alert(1)</script x>`],
    ["inline script closed by </script/>", `${GOOD}<script>alert(1)</script/>`],
    ["event handler after a slash", `<div/onclick="alert(1)">x</div>${GOOD}`],
    ["event handler after a closing quote", `<div title="a"onmouseover="alert(1)">x</div>${GOOD}`],
    ["iframe srcdoc with escaped script", `<iframe src="https://widget.thefork.com/a" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`],
    ["</template> breakout loads the provider before consent", `</template>${GOOD}`],
    ["comment hiding", `<!-- <script src="https://app.waiteraid.com/x.js"> -->${GOOD}`],
    ["a known provider's script (security review M1)", `<script src="https://app.waiteraid.com/widget/1.js"></script>`],
    ["a script hidden in mixed case beside a frame", `${FORK}<ScRiPt src="https://widget.thefork.com/x.js"></ScRiPt>`],
    ["a sandbox of its own", `<iframe src="https://widget.thefork.com/a" sandbox></iframe>`],
    ["userinfo host", `<iframe src="https://widget.thefork.com@evil.example/"></iframe>`],
    ["data url", `<iframe src="data:text/html,<script>alert(1)</script>"></iframe>`],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example">${GOOD}`],
    ["base", `<base href="https://evil.example/">${GOOD}`],
    ["svg", `<svg/onload=alert(1)>${GOOD}`],
    ["uppercase script with newline", `<SCRIPT\nsrc="https://evil.example/x.js"></SCRIPT>`],
    ["unquoted evil src", `<script src=https://evil.example/x.js></script>`],
    ["entity javascript", `<a href="&#x6a;avascript:alert(1)">x</a>${GOOD}`],
    ["second evil iframe", `${FORK}<iframe src="https://evil.example/"></iframe>`],
  ])("%s", (_name, code) => refused(code));

  it("never lets an origin carry CSP syntax", () => {
    const o = thirdPartyOrigins({ booking: { provider: "none" }, mapEmbed: "https://a.example;script-src *" });
    for (const origin of [...o.booking, ...o.map]) expect(origin).not.toMatch(/[;\s]/);
  });
});
