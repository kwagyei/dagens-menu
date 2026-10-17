// Every public photo has its sizes (plan M6.9 AC; ADR-015 §4): on each of the 14 routes, every
// <img> carries width, height and srcset; only the decorative heroes have alt=""; and every
// size a srcset names is really there (200, image/webp). Run in CI after a build, against the
// built Worker, like check-no-third-party.mjs.
//
//   node scripts/check-images.mjs --url http://localhost:8788
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROUTES } from "./check-no-third-party.mjs";

/** Classes of the photos that sit behind text and are decorative (alt=""). */
const DECORATIVE = /\bhero-(ljus|dag)__img\b/;

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}=("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (m) return m[2] ?? m[3] ?? m[4] ?? "";
  // A bare attribute is an empty value: Astro writes alt="" as plain `alt`, and HTML agrees.
  return new RegExp(`\\s${name}(?=[\\s/>])`, "i").test(tag) ? "" : null;
};

/** What's wrong with the <img> tags in one page; also returns every URL a srcset names. */
export function checkImgTags(html) {
  const problems = [];
  const urls = new Set();
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const where = (attr(tag, "src") ?? "?").slice(0, 80);
    for (const name of ["width", "height", "srcset"]) if (!attr(tag, name)) problems.push(`<img src="${where}"> has no ${name}`);
    const alt = attr(tag, "alt");
    if (alt === null) problems.push(`<img src="${where}"> has no alt`);
    else if (alt.trim() === "" && !DECORATIVE.test(attr(tag, "class") ?? "")) problems.push(`<img src="${where}"> has an empty alt but isn't a decorative hero`);
    for (const part of (attr(tag, "srcset") ?? "").split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) urls.add(url);
    }
  }
  return { problems, urls };
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" } } });
  if (!values.url) {
    console.error("Usage: check-images.mjs --url <base URL>");
    process.exit(2);
  }
  const problems = [];
  const urls = new Set();
  let images = 0;
  for (const route of ROUTES) {
    const html = await (await fetch(new URL(route, values.url))).text();
    const found = checkImgTags(html);
    images += (html.match(/<img\b/gi) ?? []).length;
    problems.push(...found.problems.map((p) => `${route}: ${p}`));
    for (const u of found.urls) urls.add(u);
  }
  for (const url of urls) {
    const res = await fetch(new URL(url, values.url), { method: "HEAD" });
    if (res.status !== 200 || !String(res.headers.get("content-type")).startsWith("image/webp")) problems.push(`${url}: ${res.status} ${res.headers.get("content-type")}`);
  }
  if (problems.length > 0) {
    console.error(`Photo problems on ${values.url}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`All ${images} photos on the ${ROUTES.length} routes have width, height and srcset, and all ${urls.size} sizes they name are served as WebP.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
