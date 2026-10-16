/**
 * Load a site's JSON content into D1 (ADR-011 plan M2.4).
 *
 *   npm run db:migrate:local                      # once, and after new migrations
 *   npm run seed -- --site bistro [--reset]       # local database (d1.local.jsonc)
 *   npm run seed -- --site bistro --remote --config <deployed config> [--reset]
 *
 * Validates the content with the schema, registers the curated images by hashing the real
 * files under public/, and refuses to touch a site that already has content unless --reset
 * is given. --reset replaces the content but keeps owners and the audit log; on the remote
 * database it is allowed only for the demo sites, so a typo can't wipe a client's menu.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { JsonContentSource } from "../src/content/json-source";
import { type ImageResolver, resetStatements, seedStatements } from "../src/db/seed";
import { checkTarget, type D1Target, execute, fail as failWith, query, root, targetName } from "./d1-cli";

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    reset: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    database: { type: "string", default: "dagens-menu" },
    config: { type: "string", default: "d1.local.jsonc" },
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
  return { id: createHash("sha256").update(bytes).digest("hex"), mime: isJpeg ? "image/jpeg" : "image/webp" };
};

let full;
try {
  ({ content: full } = await new JsonContentSource(site).load({ now: new Date() }));
} catch (error) {
  fail((error as Error).message);
}
const { theme: _theme, ...content } = full;

const [{ n: existing }] = query<{ n: number }>("seed", target, `SELECT count(*) AS n FROM settings WHERE site_id = '${site}'`);
if (existing > 0 && !values.reset) fail(`site "${site}" already has content in the ${targetName(target)} database; pass --reset to replace it`);

let statements;
try {
  statements = [...(values.reset ? resetStatements(site) : []), ...seedStatements(site, content, resolveImage)];
} catch (error) {
  fail((error as Error).message);
}
execute("seed", target, statements);
const items = content.menu.categories.reduce((n, c) => n + c.items.length, 0);
console.log(`seed: ${values.reset ? "replaced" : "loaded"} "${site}" in the ${targetName(target)} database: ${content.menu.categories.length} categories, ${items} dishes, ${statements.length} statements.`);
