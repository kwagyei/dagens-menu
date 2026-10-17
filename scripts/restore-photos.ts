/**
 * Bring an export's uploaded photos back for a restore (plan M6.4; ADR-014 §5).
 *
 * The export lists each upload's id and a link to its master (the widest size). For each one:
 * take `<dir>/<id>.webp` if a --photos folder has it, otherwise fetch the link; refuse it unless
 * its SHA-256 is the id (an altered or swapped photo never lands); check it is a clean WebP the
 * upload path would have accepted, at the width the file lists; then make the smaller sizes again
 * with sharp's libwebp at the browser's settings. The master is kept byte for byte, so its id and
 * URL stay the same.
 *
 * Any problem is one line that starts "photo <id>:", and nothing is written: the seed only builds
 * its SQL file once every photo has loaded.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { SITE_PHOTO_BYTES, SITE_PHOTO_LIMIT } from "../src/db/photos";
import type { ExportedUpload } from "../src/db/export-file";
import type { UploadBytes } from "../src/db/seed";
import { checkLadder, inspectWebp, LADDER_STEPS, MAX_VARIANT_BYTES } from "../src/server/upload-validate";

const FETCH_TIMEOUT_MS = 30_000;

class PhotoError extends Error {}
const refuse = (id: string, what: string): never => {
  throw new PhotoError(`photo ${id}: ${what}`);
};

/** The master from `<dir>/<id>.webp`, or null when the folder doesn't have it as a file. */
function fromFolder(id: string, dir: string): Uint8Array | null {
  const file = join(dir, `${id}.webp`);
  let isFile: boolean;
  try {
    lstatSync(file); // exists at all (a broken symlink falls back to the link)
    isFile = statSync(file).isFile();
  } catch {
    return null;
  }
  if (!isFile) refuse(id, `${file} is not a file`);
  try {
    return new Uint8Array(readFileSync(file));
  } catch (error) {
    return refuse(id, `couldn't read ${file} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
}

/** Fetch the master, reading no more than a photo can be, and never following a redirect. */
async function fromLink(upload: ExportedUpload): Promise<Uint8Array> {
  const { id, master } = upload;
  const hint = `pass --photos <folder> with ${id}.webp`;
  const url = new URL(master);
  if (url.username || url.password) refuse(id, `the link carries a user name or password, which a photo link never does`);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: "error" });
  } catch (error) {
    return refuse(id, `couldn't fetch ${master} (${(error as Error).message}); ${hint}`);
  }
  if (!response.ok) refuse(id, `${master} answered ${response.status}; ${hint}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_VARIANT_BYTES) refuse(id, `${master} is ${declared} bytes, more than a photo can be`);
  if (!response.body) refuse(id, `${master} sent no body; ${hint}`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > MAX_VARIANT_BYTES) refuse(id, `${master} sent more than a photo can be (over ${MAX_VARIANT_BYTES} bytes)`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    return refuse(id, `the download from ${master} stopped (${(error as Error).message}); ${hint}`);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export async function loadUploads(uploads: readonly ExportedUpload[], photosDir?: string, log: (m: string) => void = console.log): Promise<UploadBytes> {
  if (uploads.length > SITE_PHOTO_LIMIT) throw new Error(`the file has ${uploads.length} uploaded photos, more than a site may have (${SITE_PHOTO_LIMIT})`);
  const out: UploadBytes = new Map();
  let siteBytes = 0;
  for (const upload of uploads) {
    const { id } = upload;
    const master = (photosDir ? fromFolder(id, photosDir) : null) ?? (await fromLink(upload));

    const digest = createHash("sha256").update(master).digest("hex");
    if (digest !== id) refuse(id, `the file's SHA-256 is ${digest}, not its id; it has been changed, so it is refused`);
    const check = inspectWebp(master);
    if (!check.ok) return refuse(id, `not a photo the upload page accepts (${check.reason})`);
    const listed = upload.variants[upload.variants.length - 1];
    if (check.width !== listed) refuse(id, `the file lists it as ${listed} px wide, but the photo is ${check.width} px`);

    const variants: Array<{ width: number; height: number; bytes: Uint8Array }> = [];
    for (const width of LADDER_STEPS.filter((w) => w < check.width)) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await sharp(master).resize({ width }).webp({ quality: 75, effort: 4 }).toBuffer());
      } catch (error) {
        // Upload only checks headers (ADR-013), so a stored photo can fail to decode.
        return refuse(id, `its image data can't be decoded (${(error as Error).message.split("\n")[0]}); remove it from the file's images and wherever it is used, then restore again`);
      }
      const made = inspectWebp(bytes);
      if (!made.ok || bytes.length > MAX_VARIANT_BYTES) refuse(id, `couldn't make the ${width} px size`);
      if (made.ok) variants.push({ width: made.width, height: made.height, bytes });
    }
    variants.push({ width: check.width, height: check.height, bytes: master });
    const ladder = checkLadder(variants);
    if (!ladder.ok) refuse(id, `its sizes don't form the expected ladder (${ladder.reason})`);
    siteBytes += variants.reduce((n, v) => n + v.bytes.length, 0);
    if (siteBytes > SITE_PHOTO_BYTES) throw new Error(`the file's photos come to more than a site may store (${SITE_PHOTO_BYTES} bytes)`);
    out.set(id, variants);
    log(`seed: photo ${id.slice(0, 12)}… ${check.width} × ${check.height}, ${variants.length} sizes`);
  }
  return out;
}
