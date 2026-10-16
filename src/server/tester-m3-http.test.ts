/**
 * Tester (2026-10-16, ADR-011 plan M3.1, M3.3, M3.5): HTTP edge cases of the request
 * pipeline that the builder's tests don't reach. Failing tests here are defects in the
 * tester report (~/Vault/Projects/dagens-menu/tester/2026-10-16-m3-workers.md).
 */
import { describe, expect, it, vi } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import waSettings from "../../sites/westafrican/content/settings.json";
import waMenu from "../../sites/westafrican/content/menu.json";
import { siteContentSchema, type SiteSettings } from "../content/schema";
import type { ContentSource, LoadedContent } from "../content/source";
import { emergencyPage } from "./emergency";
import { type HandlerDeps, handlePage, type PageState } from "./handler";
import { isNotModified, routeClass } from "./http";

const content = siteContentSchema("bistro").parse({ settings, hours, menu, pages, gallery, theme });
const NOW = new Date("2026-10-16T10:00:00Z");

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

const ok = async (_s: PageState) => new Response("<h1>page</h1>", { headers: { "Content-Type": "text/html" } });
const notFound = async (_s: PageState) => new Response("<h1>404</h1>", { status: 404, headers: { "Content-Type": "text/html" } });
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`https://x.workers.dev${path}`, init);

async function etagOf(path: string): Promise<string> {
  const res = await handlePage(req(path), deps(), ok);
  return res.headers.get("ETag")!;
}

describe("M3.1 SITE_ID", () => {
  it.each([[""], [" bistro"], ["bistro "], ["Bistro"]])("refuses SITE_ID %j with a 500 and a log line, before touching content", async (id) => {
    const log = vi.fn();
    const load = vi.fn();
    const res = await handlePage(req("/"), deps({ runtimeSiteId: id, log, source: () => ({ load }) }), ok);
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(load).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^site: SITE_ID/));
    expect(await res.text()).not.toContain("Bistro");
  });
});

describe("M3.3 conditional requests", () => {
  it("answers 304 to HEAD as well as GET", async () => {
    const tag = await etagOf("/");
    const render = vi.fn(ok);
    const res = await handlePage(req("/", { method: "HEAD", headers: { "If-None-Match": tag } }), deps(), render);
    expect(res.status).toBe(304);
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    ['W/"b1-7-2026-10-16"', true],
    ['  W/"b1-7-2026-10-16"  ', true],
    ['"a","b",W/"b1-7-2026-10-16"', true],
    ['"b1-7-2026-10-16-x"', false],
    ['W/"b1-7-2026-10-15"', false],
    ['b1-7-2026-10-16', false], // unquoted is not an entity tag
  ])("If-None-Match %j → %s", (header, expected) => {
    expect(isNotModified(req("/", { headers: { "If-None-Match": header } }), 'W/"b1-7-2026-10-16"')).toBe(expected);
  });

  it("never answers 304 for a route that doesn't exist (If-None-Match: *)", async () => {
    // RFC 9110 §13.1.2: "*" is false when no current representation exists, so a 404 must stay a 404.
    const res = await handlePage(req("/does-not-exist", { headers: { "If-None-Match": "*" } }), deps(), notFound);
    expect(res.status).toBe(404);
  });

  it("never answers 304 for a route that doesn't exist with another page's ETag", async () => {
    const tag = await etagOf("/menu/");
    const res = await handlePage(req("/does-not-exist", { headers: { "If-None-Match": tag } }), deps(), notFound);
    expect(res.status).toBe(404);
  });

  it("puts the path in the ETag, as ADR-011 §2 specifies (hash of build, site, version, path, date)", async () => {
    expect(await etagOf("/")).not.toBe(await etagOf("/menu/"));
  });

  it("gives a 404 no ETag", async () => {
    const res = await handlePage(req("/nope"), deps(), notFound);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("does not answer 304 to POST, and does not hand out an ETag for it", async () => {
    const tag = await etagOf("/");
    const res = await handlePage(req("/", { method: "POST", headers: { "If-None-Match": tag } }), deps(), ok);
    expect(res.status).not.toBe(304);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("refuses %s on a public page with 405 and Allow: GET, HEAD", async (method) => {
    const res = await handlePage(req("/menu/", { method }), deps(), ok);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toMatch(/GET.*HEAD/);
  });
});

describe("M3.3 route classes", () => {
  it.each([
    ["/admin", "admin"],
    ["/admin/", "admin"],
    ["/admin/menu", "admin"],
    ["/en/admin/", "admin"],
    ["/administration", "public"],
    ["/menu/", "public"],
    ["/en/", "public"],
  ])("%s is %s", (path, cls) => {
    expect(routeClass(path)).toBe(cls);
  });

  it("gives the admin no-store even when the content is stale or the page is a 404", async () => {
    const stale = await handlePage(req("/admin/x"), deps({}, { stale: true }), notFound);
    expect(stale.headers.get("Cache-Control")).toBe("no-store");
    expect(stale.headers.get("ETag")).toBeNull();
  });

  it("never answers 304 on the admin", async () => {
    const res = await handlePage(req("/admin/", { headers: { "If-None-Match": "*" } }), deps(), ok);
    expect(res.status).toBe(200);
  });

  it("does not allow framing of either route class", async () => {
    for (const path of ["/", "/admin/"]) {
      const res = await handlePage(req(path), deps(), ok);
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("Content-Security-Policy")).not.toMatch(/unsafe-eval|unpkg|api\.github\.com/);
    }
  });
});

describe("M3.5 emergency page", () => {
  const down: ContentSource = { load: async () => Promise.reject(new Error("D1_ERROR")) };

  it("uses Retry-After: 120 as ADR-011 §3 specifies", async () => {
    const res = await handlePage(req("/"), deps({ source: () => down }), ok);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it("is 503 for HEAD too, carries security headers and no ETag", async () => {
    const res = await handlePage(req("/menu/", { method: "HEAD" }), deps({ source: () => down }), ok);
    expect(res.status).toBe(503);
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("is in Swedish at / and /enx, English only at /en and under /en/", async () => {
    const lang = async (path: string) => (await (await handlePage(req(path), deps({ source: () => down }), ok)).text()).match(/lang="(\w+)"/)?.[1];
    expect(await lang("/")).toBe("sv");
    expect(await lang("/enx")).toBe("sv");
    expect(await lang("/en")).toBe("en");
    expect(await lang("/en/contact/")).toBe("en");
  });

  it("shows no dish and no price for the West African site either", () => {
    for (const locale of ["sv", "en"] as const) {
      const html = emergencyPage(waSettings as SiteSettings, locale);
      expect(html).toContain("Chez Abena");
      expect(html).not.toMatch(/\d\s*kr\b/);
      for (const c of waMenu.categories) for (const i of c.items) expect(html).not.toContain(i.name[locale]);
    }
  });

  it("does not let a 304 confirm anything while the database is down", async () => {
    const res = await handlePage(req("/", { headers: { "If-None-Match": "*" } }), deps({ source: () => down }), ok);
    expect(res.status).toBe(503);
  });
});
