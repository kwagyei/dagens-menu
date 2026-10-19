// No page carries an inline script (review L2, 18 Oct; public pages since 19 Oct). No CSP
// allows one (script-src 'self'), and astro.config.mjs keeps every component script a file by
// matching Vite's module id. Should an upgrade rename that id, Astro would inline scripts again
// and the browser would block them without a sound. Run in CI after a build, against the built
// Worker, like check-images.mjs: the 14 public routes and the signed-out admin pages carry no
// inline script, and the admin pages load the admin script from a file.
//
//   node scripts/check-admin-scripts.mjs --url http://localhost:8788
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROUTES } from "./check-no-third-party.mjs";

/** Admin pages a signed-out visitor gets, in both languages: sign-in and the invite page. */
export const ADMIN_ROUTES = ["/admin/", "/en/admin/", "/admin/invite/", "/en/admin/invite/"];

/** Each inline script in a page: JSON data blocks and anything inside a comment don't count. */
export function inlineScripts(html) {
  // Comments first: a script tag inside one neither runs nor loads anything.
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const problems = [];
  for (const [, attrs, body] of live.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(attrs)) continue;
    if (/\stype\s*=\s*["']?application\/(ld\+)?json["'\s>]?/i.test(` ${attrs}`)) continue; // data, not a script
    problems.push(`an inline <script${attrs}> (${body.trim().slice(0, 60)}…)`);
  }
  return problems;
}

/** What's wrong with the <script> tags in one admin page. */
export function checkAdminScripts(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const srcs = [...live.matchAll(/<script\b([^>]*)>/gi)].map(([, attrs]) => /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]).filter(Boolean);
  // The file's own name, not a query string or another path segment.
  const fileName = (src) => new URL(src, "https://x/").pathname.split("/").pop();
  const problems = inlineScripts(html);
  if (!srcs.some((s) => /^AdminLayout\b/.test(fileName(s)))) problems.push("no external AdminLayout script");
  return problems;
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" } } });
  if (!values.url) {
    console.error("Usage: check-admin-scripts.mjs --url <base URL>");
    process.exit(2);
  }
  const problems = [];
  for (const route of ROUTES) {
    const res = await fetch(new URL(route, values.url));
    problems.push(...inlineScripts(await res.text()).map((p) => `${route}: ${p}`));
  }
  for (const route of ADMIN_ROUTES) {
    const res = await fetch(new URL(route, values.url), { redirect: "follow" });
    if (res.status !== 200) {
      problems.push(`${route}: ${res.status}`);
      continue;
    }
    problems.push(...checkAdminScripts(await res.text()).map((p) => `${route}: ${p}`));
  }
  if (problems.length > 0) {
    console.error(`Inline script problems on ${values.url}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    `No inline script on the ${ROUTES.length} public routes or the ${ADMIN_ROUTES.length} signed-out admin pages, and each admin page loads the admin script from a file.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
