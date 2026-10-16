// Post-deploy smoke test (ADR-011 plan M3.7): the live site serves this build on all 14
// public routes, with its own title, the security headers and nothing third-party before
// consent, and the admin answers without caching. A new version takes a few seconds to
// reach every edge, so each route is retried until it serves the expected build.
//
// Usage: node scripts/smoke.mjs --url https://… --title "Bistro Norden" --build 46e66ac

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROUTES, thirdPartyRequests, titleOf } from "./check-no-third-party.mjs";

/** What's wrong with one public page's response; empty when it's right. */
export function publicPageProblems(route, { status, headers, html }, { title, build }) {
  const problems = [];
  if (status !== 200) problems.push(`${route}: status ${status}`);
  if (!titleOf(html).includes(title)) problems.push(`${route}: title "${titleOf(html)}" lacks "${title}"`);
  if (!/default-src/.test(headers.get("content-security-policy") ?? "")) problems.push(`${route}: no Content-Security-Policy`);
  if (!/max-age=\d+/.test(headers.get("strict-transport-security") ?? "")) problems.push(`${route}: no Strict-Transport-Security`);
  if (!(headers.get("etag") ?? "").startsWith(`W/"${build}-`)) problems.push(`${route}: serves build ${headers.get("etag") ?? "(no ETag)"}, expected ${build}`);
  for (const request of thirdPartyRequests(html)) problems.push(`${route}: loads ${request} before consent`);
  return problems;
}

/** The admin's sign-in page: up, never cached, with the admin's own CSP. */
export function adminProblems({ status, headers }) {
  const problems = [];
  if (status !== 200) problems.push(`/admin/: status ${status}`);
  if (headers.get("cache-control") !== "no-store") problems.push(`/admin/: Cache-Control is "${headers.get("cache-control")}", expected no-store`);
  if (!/default-src/.test(headers.get("content-security-policy") ?? "")) problems.push("/admin/: no Content-Security-Policy");
  return problems;
}

async function get(url) {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" }, redirect: "manual" });
  return { status: res.status, headers: res.headers, html: await res.text() };
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" }, title: { type: "string" }, build: { type: "string" }, wait: { type: "string", default: "90" } } });
  if (!values.url || !values.title || !values.build) {
    console.error('Usage: smoke.mjs --url <base URL> --title "<site name>" --build <short sha> [--wait <seconds>]');
    process.exit(2);
  }
  const deadline = Date.now() + Number(values.wait) * 1000;
  const problems = [];
  for (const route of ROUTES) {
    let found;
    // Retry while the edge still serves the previous build; any other problem is final.
    for (;;) {
      found = publicPageProblems(route, await get(new URL(route, values.url)), values);
      const stale = found.length === 1 && found[0].includes("serves build");
      if (!stale || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    problems.push(...found);
  }
  problems.push(...adminProblems(await get(new URL("/admin/", values.url))));
  if (problems.length > 0) {
    console.error(`Smoke test failed on ${values.url}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${values.url}: build ${values.build} serves all ${ROUTES.length} routes as "${values.title}", with security headers, nothing third-party, and the admin up.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
