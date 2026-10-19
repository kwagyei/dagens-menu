/**
 * The curated photos' WebP sizes, made at build time (plan M6.9; ADR-015 §3).
 *
 * For each curated photo in sites/<site>/content/images.json: upright from its EXIF orientation,
 * the same size plan as an upload (src/content/images.ts), sharp's libwebp at quality 75, into
 * public/images/<site>/v/<name>-<width>.webp. The output is gitignored: generated binaries stay
 * out of main's history, and every build makes them again (unchanged files are skipped).
 *
 * Runs from the Astro config before each build and dev server; `--check` lists what's missing.
 *
 *   npm run image-variants -- --site bistro [--check] [--root <dir>]
 *
 * --root (default: this repository) points at another tree with the same sites/ and public/ layout;
 * the tests use it so their throwaway site never appears in the real sites/ folder.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { curatedName, curatedSizes, curatedVariantUrl } from "../src/content/images";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Plan {
  ref: string;
  source: string;
  outputs: Array<{ width: number; file: string }>;
}

async function plans(site: string, root: string): Promise<Plan[]> {
  const library = JSON.parse(readFileSync(join(root, "sites", site, "content", "images.json"), "utf-8")) as Array<{ ref: string }>;
  const out: Plan[] = [];
  const named = new Map<string, string>();
  for (const { ref } of library) {
    if (!ref.startsWith(`/images/${site}/`)) continue; // uploads live in D1, not here
    // x.jpg and x.png would both make v/x-400.webp, and one would silently replace the other.
    const name = curatedName(ref);
    const other = named.get(name);
    if (other && other !== ref) throw new Error(`image-variants: ${site}: ${other} and ${ref} would make the same files (v/${name}-*.webp); rename one`);
    named.set(name, ref);
    const source = join(root, "public", ref);
    const meta = await sharp(source).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const [w, h] = swap ? [meta.height!, meta.width!] : [meta.width!, meta.height!];
    out.push({ ref, source, outputs: curatedSizes(w, h).map((s) => ({ width: s.width, file: join(root, "public", curatedVariantUrl(ref, s.width)) })) });
  }
  return out;
}

/** Make every missing or outdated size; returns how many were written. */
export async function buildImageVariants(site: string, log: (m: string) => void = () => {}, root = REPO_ROOT): Promise<number> {
  let written = 0;
  for (const plan of await plans(site, root)) {
    const sourceTime = statSync(plan.source).mtimeMs;
    for (const { width, file } of plan.outputs) {
      if (existsSync(file) && statSync(file).mtimeMs >= sourceTime) continue;
      mkdirSync(dirname(file), { recursive: true });
      await sharp(plan.source).rotate().resize({ width }).webp({ quality: 75, effort: 4 }).toFile(file);
      written++;
    }
  }
  if (written > 0) log(`image-variants: ${site}: wrote ${written} WebP size(s)`);
  return written;
}

/** Each listed curated photo's sizes that aren't on disk. */
export async function missingImageVariants(site: string, root = REPO_ROOT): Promise<string[]> {
  return (await plans(site, root)).flatMap((p) => p.outputs.filter((o) => !existsSync(o.file)).map((o) => `${p.ref} → ${o.width} px`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--site");
  const site = at > 0 ? process.argv[at + 1] : undefined;
  if (!site || !/^[a-z0-9-]+$/.test(site)) {
    console.error("image-variants: --site <id> is required");
    process.exit(2);
  }
  const rootAt = process.argv.indexOf("--root");
  const root = rootAt > 0 ? process.argv[rootAt + 1] : REPO_ROOT;
  if (!root) {
    console.error("image-variants: --root needs a directory");
    process.exit(2);
  }
  if (process.argv.includes("--check")) {
    const missing = await missingImageVariants(site, root);
    if (missing.length > 0) {
      console.error(`image-variants: ${site}: ${missing.length} size(s) missing:\n  ${missing.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`image-variants: ${site}: every listed curated photo has all its sizes`);
  } else {
    await buildImageVariants(site, console.log, root);
  }
}
