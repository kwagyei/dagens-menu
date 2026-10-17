import { describe, expect, it } from "vitest";
import { buildRobots, buildSitemap, PAGE_PATHS } from "../src/server/sitemap";
import { ROUTES } from "../scripts/check-no-third-party.mjs";

const origin = "https://bistro.example.workers.dev";

describe("buildSitemap", () => {
  const xml = buildSitemap(origin);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  it("lists exactly the 14 public routes, absolute", () => {
    expect(locs).toEqual(expect.arrayContaining(ROUTES.map((r) => origin + r)));
    expect(locs).toHaveLength(ROUTES.length);
    expect(PAGE_PATHS).toHaveLength(7);
  });
  it("gives every entry both hreflang alternates", () => {
    expect([...xml.matchAll(/hreflang="sv"/g)]).toHaveLength(14);
    expect([...xml.matchAll(/hreflang="en"/g)]).toHaveLength(14);
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="en" href="${origin}/en/menu/"/>`);
  });
  it("never lists an admin page", () => {
    expect(xml).not.toContain("admin");
  });
  it("is well-formed XML with the declaration first", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });
  it("uses the origin it was asked for, so a custom domain just works", () => {
    expect(buildSitemap("https://bistronorden.se")).toContain("<loc>https://bistronorden.se/en/menu/</loc>");
  });
});

describe("buildRobots", () => {
  it("points at the sitemap on the same origin and keeps the admin out", () => {
    const txt = buildRobots(origin);
    expect(txt).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(txt).toContain("Disallow: /admin/");
    expect(txt).toContain("Disallow: /en/admin/");
  });
});
