// Fails if any built public page loads a resource from another origin on page load.
//
// The privacy page promises visitors that nothing third-party loads before they consent:
// maps and booking widgets are injected by script only after the consent click. This check
// enforces that promise on the build output, so a hard-coded embed or CDN link cannot slip in.
// The CMS admin page is excluded — only the owner opens it, and Decap is served from unpkg.
//
// Usage: node scripts/check-no-third-party.mjs [distDir]

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const distDir = process.argv[2] ?? "dist";
const EXCLUDED = new Set(["admin/index.html"]);

// Elements whose src/href/srcset/poster the browser fetches immediately. Plain <a href> is a
// navigation, not a request, so outbound links to Instagram etc. are fine.
const FETCHING_TAG = /<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*>/gi;
const URL_ATTR = /\b(src|href|srcset|poster|data)\s*=\s*["']([^"']*)["']/gi;
const EXTERNAL = /(^|[\s,])(https?:)?\/\//i;

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

const violations = [];
let checked = 0;
for (const file of htmlFiles(distDir)) {
  const rel = relative(distDir, file);
  if (EXCLUDED.has(rel)) continue;
  checked++;
  // Drop <template> contents: they are inert until script clones them after consent.
  const html = readFileSync(file, "utf-8").replace(/<template\b[\s\S]*?<\/template>/gi, "");
  for (const [tag] of html.matchAll(FETCHING_TAG)) {
    for (const [, attr, value] of tag.matchAll(URL_ATTR)) {
      if (EXTERNAL.test(value)) violations.push(`${rel}: ${attr}="${value}"`);
    }
  }
}

if (checked === 0) {
  console.error(`No HTML found in ${distDir} — run the build first.`);
  process.exit(1);
}
if (violations.length > 0) {
  console.error(`Third-party requests before consent:\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log(`No third-party requests on load in ${checked} pages.`);
