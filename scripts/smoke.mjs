// Post-deploy smoke test (ADR-011 plan M3.7): the live site serves this build on all 14
// public routes, with its own title, the security headers and nothing third-party before
// consent, and the admin answers without caching. Photos: the gallery lists photos with their
// library alt text, its first photo is served as WebP, and an unknown /media id is a sandboxed
// 404. A new version takes a few seconds to
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

// Any id no photo has: 64 hex digits, so it passes the route's pattern and reaches D1.
export const UNKNOWN_MEDIA = `/media/${"0".repeat(64)}-400.webp`;

/** The gallery's photos: at least one, each with alt text. Returns the first photo's URL too. */
export function galleryProblems(route, html) {
  const list = html.match(/<ul\b[^>]*\bclass=["'][^"']*\bgallery-magazine\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
  // A tag runs to the first > outside quotes, so a > in alt text doesn't cut it short.
  const attr = (tag, name) => tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`))?.slice(1).find((v) => v !== undefined);
  const images = [...list.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map(([tag]) => ({ src: attr(tag, "src"), alt: attr(tag, "alt") }));
  const problems = [];
  if (images.length === 0) problems.push(`${route}: the gallery lists no photos`);
  images.forEach((image, i) => {
    if (!image.alt?.trim()) problems.push(`${route}: gallery photo ${i + 1} (${image.src}) has no alt text`);
  });
  return { problems, photo: images[0]?.src };
}

/** A photo the gallery links to: served, as WebP. */
export function photoProblems(path, { status, headers }) {
  const problems = [];
  if (status !== 200) problems.push(`${path}: status ${status}`);
  if (headers.get("content-type") !== "image/webp") problems.push(`${path}: Content-Type is "${headers.get("content-type")}", expected image/webp`);
  return problems;
}

/** A /media id that doesn't exist: 404, with the sandbox policy every /media answer has. */
export function unknownMediaProblems({ status, headers }) {
  const problems = [];
  if (status !== 404) problems.push(`${UNKNOWN_MEDIA}: status ${status}, expected 404`);
  if (headers.get("content-security-policy") !== "default-src 'none'; sandbox") {
    problems.push(`${UNKNOWN_MEDIA}: Content-Security-Policy is "${headers.get("content-security-policy")}", expected the sandbox`);
  }
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
  const gallery = galleryProblems("/gallery/", (await get(new URL("/gallery/", values.url))).html);
  problems.push(...gallery.problems);
  if (gallery.photo) problems.push(...photoProblems(gallery.photo, await get(new URL(gallery.photo, values.url))));
  problems.push(...unknownMediaProblems(await get(new URL(UNKNOWN_MEDIA, values.url))));
  if (problems.length > 0) {
    console.error(`Smoke test failed on ${values.url}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${values.url}: build ${values.build} serves all ${ROUTES.length} routes as "${values.title}", with security headers, nothing third-party, the admin up, and its photos served.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
