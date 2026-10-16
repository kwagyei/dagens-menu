/**
 * Load a site's JSON content into D1 (ADR-011 plan M2.4).
 *
 *   npm run seed -- --site bistro [--reset] [--remote] [--database dagens-menu] [--config wrangler.jsonc]
 *
 * Validates the content with the schema, registers the curated images by hashing the real
 * files under public/, and refuses to touch a site that already has content unless --reset
 * is given (demos only: it replaces the content but keeps owners and the audit log).
 * Local by default; --remote writes to the real database.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JsonContentSource } from "../src/content/json-source";
import { type ImageResolver, resetStatements, seedStatements } from "../src/db/seed";
import { renderSql } from "../src/db/sql";

const { values } = parseArgs({
  options: {
    site: { type: "string" },
    reset: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    database: { type: "string", default: "dagens-menu" },
    config: { type: "string", default: "wrangler.jsonc" },
  },
});

function fail(message: string): never {
  console.error(`seed: ${message}`);
  process.exit(1);
}

const site = values.site;
if (!site || !/^[a-z0-9-]+$/.test(site)) fail("--site <id> is required, e.g. --site bistro");
const target = values.remote ? "--remote" : "--local";
const root = resolve(import.meta.dirname, "..");

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", "d1", "execute", values.database!, target, "--config", values.config!, ...args], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

const { content: full } = await new JsonContentSource(site).load({ now: new Date() });
const { theme: _theme, ...content } = full;

let existing: number;
try {
  const out = JSON.parse(wrangler(["--json", "--command", `SELECT count(*) AS n FROM settings WHERE site_id = '${site}'`]));
  existing = out[0].results[0].n;
} catch (error) {
  fail(`could not query the ${target.slice(2)} database (have the migrations been applied?)\n${(error as { stderr?: string }).stderr ?? error}`);
}
if (existing > 0 && !values.reset) fail(`site "${site}" already has content in the ${target.slice(2)} database; pass --reset to replace it`);

const statements = [...(values.reset ? resetStatements(site) : []), ...seedStatements(site, content, resolveImage)];
const dir = mkdtempSync(join(tmpdir(), "seed-"));
const file = join(dir, `${site}.sql`);
try {
  writeFileSync(file, renderSql(statements));
  wrangler(["--file", file, "-y"]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const items = content.menu.categories.reduce((n, c) => n + c.items.length, 0);
console.log(`seed: ${values.reset ? "replaced" : "loaded"} "${site}" in the ${target.slice(2)} database: ${content.menu.categories.length} categories, ${items} dishes, ${statements.length} statements.`);
