/**
 * Load a site's JSON content into D1 (ADR-011 plan M2.4).
 *
 *   npm run db:migrate:local                      # once, and after new migrations
 *   npm run seed -- --site bistro [--reset]       # local database (d1.local.jsonc)
 *   npm run seed -- --site bistro --remote --config <deployed config> [--reset]
 *   npm run seed -- --site bistro --from bistro-content-2026-10-16.json --reset   # restore an export
 *
 * --from loads an owner's "Export my content" file (plan M5.6) instead of sites/<site>/;
 * the theme still comes from the repository. Validates the content with the schema, registers the curated images by hashing the real
 * files under public/, and refuses to touch a site that already has content unless --reset
 * is given. --reset replaces the content but keeps owners and the audit log; on the remote
 * database it is allowed only for the demo sites, so a typo can't wipe a client's menu.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { JsonContentSource } from "../src/content/json-source";
import { readExportFile } from "../src/db/export-file";
import { type ImageResolver, resetStatements, seedStatements } from "../src/db/seed";
import { checkTarget, type D1Target, execute, fail as failWith, query, root, targetName } from "./d1-cli";

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    reset: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    database: { type: "string", default: "dagens-menu" },
    config: { type: "string", default: "d1.local.jsonc" },
    from: { type: "string" },
  },
});

const fail: (message: string) => never = (message) => failWith("seed", message);

const site = values.site;
if (!site || !/^[a-z0-9-]+$/.test(site)) fail("--site <id> is required, e.g. --site bistro");
const target: D1Target = { database: values.database!, config: values.config!, remote: values.remote! };

/** Sites whose content is sample data and may be replaced on the real database. */
const DEMO_SITES = ["bistro", "westafrican"];
if (values.remote && values.reset && !DEMO_SITES.includes(site)) {
  fail(`--remote --reset is only allowed for the demo sites (${DEMO_SITES.join(", ")}); restore a client from Time Travel instead`);
}
checkTarget("seed", target);
if (values.remote) {
  console.warn("seed: note: a remote import makes the database unavailable to every site while it runs (seconds); prefer off-peak hours.");
}

/** Pixel sizes of the library's curated files, read with sharp before the statements are built. */
const sizes = new Map<string, { width: number; height: number }>();

/** Hash the real file; only JPEG and WebP are accepted (ADR-011 §7). */
const resolveImage: ImageResolver = (path) => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, "public", path));
  } catch {
    fail(`image ${path} is referenced by the content but not found under public/`);
  }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (!isJpeg && !isWebp) fail(`image ${path} is not a JPEG or WebP file`);
  return { id: createHash("sha256").update(bytes).digest("hex"), mime: isJpeg ? "image/jpeg" : "image/webp", ...sizes.get(path) };
};

let full;
try {
  ({ content: full } = await new JsonContentSource(site).load({ now: new Date() }));
} catch (error) {
  fail((error as Error).message);
}
const { theme, ...fromRepository } = full;
let content = fromRepository;
let summary: string | undefined;
if (values.from) {
  let text: string;
  try {
    text = readFileSync(values.from, "utf-8");
  } catch {
    fail(`can't read ${values.from}`);
  }
  // Booking and the map are operator-only (ADR-011 §8): they come from the repository.
  const read = readExportFile(text, site, { theme, settings: fromRepository.settings, images: fromRepository.images });
  if (!read.ok) fail(`${values.from}: ${read.error}`);
  if (read.operatorFieldsReplaced) console.warn(`seed: the file's booking and map settings differ from sites/${site}/; keeping the repository's (operator-only).`);
  if (read.highlightImagesDropped > 0) console.warn(`seed: the file is format 1; dropped ${read.highlightImagesDropped} per-highlight photo(s), which the content model no longer has.`);
  content = read.content;
  summary = `Restored from ${basename(values.from).replace(/[^\w.-]/g, "_").slice(0, 80)} (exported ${read.exportedAt})`;
  console.log(`seed: restoring "${site}" from ${values.from} (exported ${read.exportedAt}).`);
}

const [{ n: existing }] = query<{ n: number }>("seed", target, `SELECT count(*) AS n FROM settings WHERE site_id = '${site}'`);
if (existing > 0 && !values.reset) fail(`site "${site}" already has content in the ${targetName(target)} database; pass --reset to replace it`);

for (const { ref } of content.images) {
  try {
    const meta = await sharp(join(root, "public", ref)).metadata();
    // Width and height as displayed: EXIF orientations 5–8 swap them.
    const swap = (meta.orientation ?? 1) >= 5;
    if (meta.width && meta.height) sizes.set(ref, swap ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height });
  } catch {
    // An upload id or a missing file: seedStatements reports it with a clear message.
  }
}

let statements;
try {
  statements = [...(values.reset ? resetStatements(site) : []), ...seedStatements(site, content, resolveImage, new Date(), summary)];
} catch (error) {
  fail((error as Error).message);
}
execute("seed", target, statements);
const items = content.menu.categories.reduce((n, c) => n + c.items.length, 0);
console.log(`seed: ${values.reset ? "replaced" : "loaded"} "${site}" in the ${targetName(target)} database: ${content.menu.categories.length} categories, ${items} dishes, ${statements.length} statements.`);
