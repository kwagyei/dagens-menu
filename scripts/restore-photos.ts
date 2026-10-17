/**
 * Bring an export's uploaded photos back for a restore (plan M6.4; ADR-014 §5).
 *
 * The export lists each upload's id and a link to its master (the widest size). For each one:
 * take `<dir>/<id>.webp` if a --photos folder has it, otherwise fetch the link; refuse it unless
 * its SHA-256 is the id (an altered or swapped photo never lands); check it is a clean WebP the
 * upload path would have accepted; then make the smaller sizes again with sharp's libwebp at the
 * browser's settings. The master is kept byte for byte, so its id and URL stay the same.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { ExportedUpload } from "../src/db/export-file";
import type { UploadBytes } from "../src/db/seed";
import { checkLadder, inspectWebp, LADDER_STEPS, MAX_VARIANT_BYTES } from "../src/server/upload-validate";

const FETCH_TIMEOUT_MS = 30_000;

export async function loadUploads(uploads: readonly ExportedUpload[], photosDir?: string, log: (m: string) => void = console.log): Promise<UploadBytes> {
  const out: UploadBytes = new Map();
  for (const upload of uploads) {
    const file = photosDir ? join(photosDir, `${upload.id}.webp`) : null;
    let master: Uint8Array;
    if (file && existsSync(file)) {
      master = new Uint8Array(readFileSync(file));
    } else {
      const response = await fetch(upload.master, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch((error: Error) => {
        throw new Error(`photo ${upload.id}: couldn't fetch ${upload.master} (${error.message}); pass --photos <folder> with ${upload.id}.webp`);
      });
      if (!response.ok) throw new Error(`photo ${upload.id}: ${upload.master} answered ${response.status}; pass --photos <folder> with ${upload.id}.webp`);
      master = new Uint8Array(await response.arrayBuffer());
    }

    const digest = createHash("sha256").update(master).digest("hex");
    if (digest !== upload.id) throw new Error(`photo ${upload.id}: the file's SHA-256 is ${digest}, not its id; it has been changed, so it is refused`);
    const check = inspectWebp(master);
    if (!check.ok) throw new Error(`photo ${upload.id}: not a photo the upload page accepts (${check.reason})`);

    const variants: Array<{ width: number; height: number; bytes: Uint8Array }> = [];
    for (const width of LADDER_STEPS.filter((w) => w < check.width)) {
      const bytes = new Uint8Array(await sharp(master).resize({ width }).webp({ quality: 75, effort: 4 }).toBuffer());
      const made = inspectWebp(bytes);
      if (!made.ok || bytes.length > MAX_VARIANT_BYTES) throw new Error(`photo ${upload.id}: couldn't make the ${width} px size`);
      variants.push({ width: made.width, height: made.height, bytes });
    }
    variants.push({ width: check.width, height: check.height, bytes: master });
    const ladder = checkLadder(variants);
    if (!ladder.ok) throw new Error(`photo ${upload.id}: its sizes don't form the expected ladder (${ladder.reason})`);
    out.set(upload.id, variants);
    log(`seed: photo ${upload.id.slice(0, 12)}… ${check.width} × ${check.height}, ${variants.length} sizes`);
  }
  return out;
}
