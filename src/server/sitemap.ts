import { pageLinks } from "./page-links";

/** The seven public pages in Swedish; each has an English twin under /en/. */
export const PAGE_PATHS = ["/", "/menu/", "/book/", "/about/", "/gallery/", "/contact/", "/privacy/"] as const;

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * sitemap.xml for every public page in both languages, each entry naming its twin as an
 * hreflang alternate (and itself, as Google asks). URLs are built from the request origin,
 * like the canonical links, so the same code serves workers.dev and a custom domain.
 */
export function buildSitemap(origin: string): string {
  const urls = PAGE_PATHS.flatMap((path) => {
    const links = pageLinks(new URL(path, origin), "sv");
    return [links.sv, links.en].map((loc) => {
      const alternates = (["sv", "en"] as const).map((lang) => `    <xhtml:link rel="alternate" hreflang="${lang}" href="${escapeXml(links[lang])}"/>`).join("\n");
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n${alternates}\n  </url>`;
    });
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

/** robots.txt: crawl the public pages, keep the owner admin out, point at the sitemap. */
export function buildRobots(origin: string): string {
  return `User-agent: *
Disallow: /admin/
Disallow: /en/admin/

Sitemap: ${new URL("/sitemap.xml", origin).href}
`;
}
