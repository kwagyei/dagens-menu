// The admin's own script stays a file (review L2, 18 Oct). Its CSP allows no inline script
// (script-src 'self'), and astro.config.mjs keeps the admin layout's script external by
// matching Vite's module id. Should an upgrade rename that id, Astro would inline the script
// again and the browser would block it without a sound. Run in CI after a build, against the
// built Worker, like check-images.mjs: every signed-out admin page must load the admin script
// from a file and carry no inline script at all.
//
//   node scripts/check-admin-scripts.mjs --url http://localhost:8788
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Admin pages a signed-out visitor gets, in both languages: sign-in and the invite page. */
export const ADMIN_ROUTES = ["/admin/", "/en/admin/", "/admin/invite/", "/en/admin/invite/"];

/** What's wrong with the <script> tags in one admin page. */
export function checkAdminScripts(html) {
  const problems = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const srcs = scripts.map(([, attrs]) => /\ssrc=["']?([^"'\s>]+)/i.exec(attrs)?.[1]).filter(Boolean);
  for (const [, attrs, body] of scripts) {
    if (/\ssrc=/i.test(attrs)) continue;
    if (/type=["']?application\/(ld\+)?json/i.test(attrs)) continue; // data, not a script
    problems.push(`an inline <script${attrs}> (${body.trim().slice(0, 60)}…)`);
  }
  if (!srcs.some((s) => /AdminLayout/.test(s))) problems.push("no external AdminLayout script");
  return problems;
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" } } });
  if (!values.url) {
    console.error("Usage: check-admin-scripts.mjs --url <base URL>");
    process.exit(2);
  }
  const problems = [];
  for (const route of ADMIN_ROUTES) {
    const res = await fetch(new URL(route, values.url), { redirect: "follow" });
    if (res.status !== 200) {
      problems.push(`${route}: ${res.status}`);
      continue;
    }
    problems.push(...checkAdminScripts(await res.text()).map((p) => `${route}: ${p}`));
  }
  if (problems.length > 0) {
    console.error(`Admin script problems on ${values.url}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`All ${ADMIN_ROUTES.length} signed-out admin pages load the admin script from a file and carry no inline script.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
