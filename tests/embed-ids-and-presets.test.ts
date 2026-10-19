/**
 * Review L5, 18 Oct (tester, 19 Oct): dropping `id` and iframe `name` from pasted embed code
 * breaks no preset's embedPattern, and no other accepted attribute can name an element or a
 * window property that a public page's script looks up.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { embedProvider } from "../src/booking/embed";
import { listPresets } from "../src/booking/presets";

const SRC = "https://widget.thefork.com/abc";
const FRAME = `<iframe src="${SRC}"></iframe>`;
const refused = (code: string) => expect(embedProvider(code)).toHaveProperty("problem");
const accepted = (code: string) => expect(embedProvider(code)).toHaveProperty("html");

describe("every preset's own embed pattern still parses", () => {
  const withPattern = Object.entries(listPresets()).filter(([, p]) => p.embedPattern);
  it("there are some", () => expect(withPattern.length).toBeGreaterThan(0));
  it.each(withPattern)("%s", (id, preset) => expect(embedProvider(preset.embedPattern!)).toMatchObject({ id }));
});

describe("the demo sites' embed code, if any, still parses", () => {
  it.each(
    readdirSync("sites", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  )("%s", (site) => {
    const settings = JSON.parse(readFileSync(`sites/${site}/content/settings.json`, "utf8"));
    if (settings.booking.embedCode?.trim()) accepted(settings.booking.embedCode);
  });
});

describe("no attribute that names an element or a browsing context", () => {
  it.each([
    ["ID in capitals", `<div ID="booking-content">${FRAME}</div>`],
    ["Id mixed case on the frame", `<iframe Id="booking-embed" src="${SRC}"></iframe>`],
    ["xml:id", `<div xml:id="booking-content">${FRAME}</div>`],
    ["NAME on the frame", `<iframe NAME="booking" src="${SRC}"></iframe>`],
    ["name on a link", `${FRAME}<a name="booking-content" href="https://example.com">x</a>`],
    ["name on a div", `<div name="x">${FRAME}</div>`],
    ["form", `<div form="f">${FRAME}</div>`],
    ["for", `<span for="consent-accept">x</span>${FRAME}`],
    ["popovertarget", `<div popovertarget="consent-banner">${FRAME}</div>`],
    ["aria-labelledby", `<div aria-labelledby="booking-content">${FRAME}</div>`],
    ["anchor", `<div anchor="booking-content">${FRAME}</div>`],
    ["itemid", `<div itemid="x">${FRAME}</div>`],
    ["slot", `<div slot="x">${FRAME}</div>`],
    ["is", `<div is="x">${FRAME}</div>`],
    ["srcdoc", `<iframe src="${SRC}" srcdoc="&lt;p id=booking-content&gt;"></iframe>`],
    ["an entity-encoded attribute name is just an unknown name", `<div &#105;d="x">${FRAME}</div>`],
  ])("refuses %s", (_, code) => refused(code));
});

describe("what is still accepted can't be looked up by a public page script", () => {
  // class and data-* stay allowed. That's safe only while no public page script selects
  // elements by class or data-* on the book page; this pins it.
  it("accepts class and data-* on a wrapper", () => accepted(`<div class="booking" data-provider="thefork">${FRAME}</div>`));
  it("BookingWidget looks its elements up by id only", () => {
    const widget = readFileSync("src/components/BookingWidget.astro", "utf8");
    const script = widget.slice(widget.indexOf("<script>"));
    expect(script).not.toMatch(/querySelector|getElementsBy|\[data-|\.dataset|document\.forms|window\[/);
  });
});
