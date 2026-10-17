// Fails if any public page loads a resource from another origin on page load, or if any of
// the site's routes doesn't render.
//
// The privacy page promises visitors that nothing third-party loads before they consent:
// maps and booking widgets are injected by script only after the consent click. Pages are
// rendered by the Worker on request (ADR-011), so this crawls a running Worker rather than
// reading built files.
//
// Usage: node scripts/check-no-third-party.mjs --url http://localhost:8788 --title "Bistro Norden"

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The 14 public routes: seven pages in Swedish at /, the same in English under /en/. */
export const ROUTES = ["/", "/menu/", "/book/", "/about/", "/gallery/", "/contact/", "/privacy/"].flatMap((p) => [
  p,
  p === "/" ? "/en/" : `/en${p}`,
]);

// Elements whose src/href/srcset/poster the browser fetches immediately. Plain <a href> is a
// navigation, not a request, so outbound links to Instagram etc. are fine.
const FETCHING_TAG = /<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*>/gi;
const URL_ATTR = /\b(src|href|srcset|poster|data)\s*=\s*["']([^"']*)["']/gi;
// <link rel="canonical"> and rel="alternate" (hreflang) only describe the page to search engines;
// the browser never fetches them, and they must be absolute URLs.
const NOT_FETCHED_LINK = /^<link\b[^>]*\brel\s*=\s*["'](?:canonical|alternate)["']/i;
const EXTERNAL = /(^|[\s,])(https?:)?\/\//i;
// CSS can fetch too: url(...) and @import in <style> blocks and style attributes.
const CSS_URL = /(?:url\(\s*["']?|@import\s+["'])((?:https?:)?\/\/[^"')\s]+)/gi;

/** The third-party URLs a page would fetch on load. */
export function thirdPartyRequests(html) {
  // <template> contents are inert until script clones them after consent.
  const page = html.replace(/<template\b[\s\S]*?<\/template>/gi, "");
  const found = [];
  for (const [tag] of page.matchAll(FETCHING_TAG)) {
    if (NOT_FETCHED_LINK.test(tag)) continue;
    for (const [, attr, value] of tag.matchAll(URL_ATTR)) {
      if (EXTERNAL.test(value)) found.push(`${attr}="${value}"`);
    }
  }
  for (const [, url] of page.matchAll(CSS_URL)) found.push(`css url(${url})`);
  return found;
}

export function titleOf(html) {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1].trim() ?? "";
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" }, title: { type: "string" } } });
  if (!values.url || !values.title) {
    console.error('Usage: check-no-third-party.mjs --url <base URL> --title "<site name>"');
    process.exit(2);
  }
  const problems = [];
  for (const route of ROUTES) {
    const res = await fetch(new URL(route, values.url));
    const html = await res.text();
    if (res.status !== 200) problems.push(`${route}: status ${res.status}`);
    if (!titleOf(html).includes(values.title)) problems.push(`${route}: title "${titleOf(html)}" lacks "${values.title}"`);
    for (const request of thirdPartyRequests(html)) problems.push(`${route}: ${request}`);
  }
  if (problems.length > 0) {
    console.error(`Problems on ${values.url}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`All ${ROUTES.length} routes render with "${values.title}" and load nothing third-party.`);
}

// Run only as a script, not when the tests import the helpers. (Compare paths, not URLs: a
// space in the checkout path is %20 in the URL.)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
