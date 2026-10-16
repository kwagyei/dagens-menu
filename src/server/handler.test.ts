import { describe, expect, it, vi } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { siteContentSchema, type SiteSettings } from "../content/schema";
import type { ContentSource, LoadedContent } from "../content/source";
import { emergencyPage } from "./emergency";
import { type HandlerDeps, handlePage, type PageState } from "./handler";
import { etagFor, isNotModified } from "./http";
import { serializeJsonLd as jsonLd } from "./json-ld";

const content = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, theme });
const NOW = new Date("2026-10-16T10:00:00Z"); // a Friday in Stockholm

function deps(overrides: Partial<HandlerDeps> = {}, loaded: Partial<LoadedContent> = {}): HandlerDeps {
  const source: ContentSource = { load: async () => ({ content, version: "7", stale: false, soldOutOn: {}, ...loaded }) };
  return {
    runtimeSiteId: "bistro",
    buildSiteId: "bistro",
    buildId: "b1",
    source: () => source,
    emergencySettings: () => settings as SiteSettings,
    now: () => NOW,
    log: () => {},
    ...overrides,
  };
}

const page = async (state: PageState) => new Response(`<h1>${state.content.settings.name.sv}</h1>`, { headers: { "Content-Type": "text/html" } });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://x.workers.dev${path}`, { headers });

describe("handlePage", () => {
  it("renders with security headers, no-cache and an ETag of build, version and date", async () => {
    const res = await handlePage(get("/menu/"), deps(), page);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('W/"b1-7-2026-10-16"');
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).not.toMatch(/unpkg|unsafe-eval/);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("answers 304 without rendering when the browser has this version for today", async () => {
    const render = vi.fn(page);
    const res = await handlePage(get("/menu/", { "If-None-Match": 'W/"b1-7-2026-10-16"' }), deps(), render);
    expect(res.status).toBe(304);
    expect(render).not.toHaveBeenCalled();
    expect(res.headers.get("ETag")).toBe('W/"b1-7-2026-10-16"');
  });

  it("renders again after a save, and again at Stockholm midnight", async () => {
    const tag = 'W/"b1-7-2026-10-16"';
    const afterSave = await handlePage(get("/", { "If-None-Match": tag }), deps({}, { version: "8" }), page);
    expect(afterSave.status).toBe(200);
    const midnight = new Date("2026-10-16T22:00:00Z"); // 00:00 on the 17th in Stockholm
    const nextDay = await handlePage(get("/", { "If-None-Match": tag }), deps({ now: () => midnight }), page);
    expect(nextDay.status).toBe(200);
    expect(nextDay.headers.get("ETag")).toBe('W/"b1-7-2026-10-17"');
  });

  it("gives the page today's hours and today's sold-out dishes", async () => {
    let state: PageState | undefined;
    const id = menu.categories[0].items[0].id;
    await handlePage(get("/"), deps({}, { soldOutOn: { [id]: "2026-10-16" } }), async (s) => ((state = s), page(s)));
    expect(state?.today).toEqual({ date: "2026-10-16", hours: { open: "11:00", close: "23:00" }, soldOut: [id] });
  });

  it("never stores the admin and never gives it an ETag", async () => {
    const res = await handlePage(get("/admin/"), deps(), page);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("marks a stale copy and never confirms it with a 304", async () => {
    const render = vi.fn(page);
    const res = await handlePage(get("/", { "If-None-Match": 'W/"b1-7-2026-10-16"' }), deps({}, { stale: true }), render);
    expect(res.status).toBe(200);
    expect(render).toHaveBeenCalled();
    expect(res.headers.get("X-Content-Stale")).toBe("1");
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("refuses to serve another site's content, with a clear log line", async () => {
    const log = vi.fn();
    const render = vi.fn(page);
    const res = await handlePage(get("/"), deps({ runtimeSiteId: "westafrican", log }), render);
    expect(res.status).toBe(500);
    expect(render).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/"westafrican" does not match.*"bistro"/));
  });

  it("refuses a missing SITE_ID", async () => {
    const res = await handlePage(get("/"), deps({ runtimeSiteId: undefined }), page);
    expect(res.status).toBe(500);
  });

  it("shows the emergency page, 503 with Retry-After, when content can't be loaded", async () => {
    const down: ContentSource = { load: async () => Promise.reject(new Error("D1 unavailable")) };
    const res = await handlePage(get("/en/menu/"), deps({ source: () => down }), page);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('lang="en"');
    expect(html).toContain("Bistro Norden");
    expect(html).toContain(settings.phone);
  });
});

describe("emergencyPage", () => {
  it("shows how to reach the restaurant and nothing from the menu", () => {
    const html = emergencyPage(settings as SiteSettings, "sv");
    expect(html).toContain("Bistro Norden");
    expect(html).toContain(settings.address);
    for (const category of menu.categories) {
      for (const item of category.items) expect(html).not.toContain(item.name.sv);
    }
    expect(html).not.toMatch(/\bkr\b/);
  });

  it("escapes the details it shows", () => {
    const html = emergencyPage({ ...(settings as SiteSettings), name: { sv: "<script>x</script>", en: "x" } }, "sv");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("isNotModified", () => {
  const tag = etagFor("7", "2026-10-16", "b1");
  it.each([
    [tag, true],
    ['"b1-7-2026-10-16"', true],
    [`"other", ${tag}`, true],
    ["*", true],
    ['W/"b1-6-2026-10-16"', false],
    ["", false],
  ])("If-None-Match %j → %s", (header, expected) => {
    expect(isNotModified(get("/", header ? { "If-None-Match": header } : {}), tag)).toBe(expected);
  });
});

describe("jsonLd", () => {
  it("keeps a dish name from closing the script block", () => {
    const out = jsonLd({ name: "</script><script>alert(1)</script>" });
    expect(out).not.toMatch(/<\/?script/i);
    expect(JSON.parse(out)).toEqual({ name: "</script><script>alert(1)</script>" });
  });

  it("escapes &, > and the JavaScript line separators while staying valid JSON", () => {
    const value = { a: "Fish & chips > 100 kr", b: "line\u2028break\u2029" };
    const out = jsonLd(value);
    expect(out).not.toMatch(new RegExp("[&>\\u2028\\u2029]"));
    expect(JSON.parse(out)).toEqual(value);
  });
});
