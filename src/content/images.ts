/**
 * Where a library photo's sizes are, for `srcset` (plan M6.9; ADR-015 §3–4). Pure; no markup.
 *
 * - A curated photo's WebP sizes are made at build time (scripts/image-variants.ts) under
 *   /images/<site>/v/<name>-<width>.webp, with the same size plan as an upload (fit 1600 × 2400,
 *   the 400/800/1200 ladder, a master just above a step cut to it).
 * - An upload's sizes are served from /media/<id>-<width>.webp: the ladder below its stored
 *   master width, then the master.
 */
import { planSizes } from "../admin/resize";
import { LADDER_STEPS } from "../server/upload-validate";
import { isUploadRef, type LibraryImage } from "./schema";

export interface PhotoSources {
  /** The size browsers without srcset use, and the one srcset falls back to: 800 or the master. */
  src: string;
  srcset: string;
  width: number;
  height: number;
  sizes: Array<{ width: number; height: number; url: string }>;
}

/** A curated file's name inside its site folder, without the extension: "kottbullar-hero". */
export const curatedName = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

/** The URL of one curated size. The folder is the ref's own, so a site only ever links its own files. */
export const curatedVariantUrl = (ref: string, width: number) => `${ref.slice(0, ref.lastIndexOf("/"))}/v/${curatedName(ref)}-${width}.webp`;

/** The sizes a curated photo of `width` × `height` gets, the same plan as an upload's. */
export function curatedSizes(width: number, height: number): Array<{ width: number; height: number }> {
  const plan = planSizes(0, width, height);
  return plan.ok ? plan.sizes : [];
}

/**
 * The sizes of a library image, or null if the library doesn't know its size (a curated row
 * from before M6.3's re-seed, or a file too small for the ladder): the caller then falls back
 * to the original file, so a photo is never lost over it.
 */
export function photoSources(image: Pick<LibraryImage, "ref" | "width" | "height">): PhotoSources | null {
  if (!image.width || !image.height) return null;
  let sizes: Array<{ width: number; height: number; url: string }>;
  if (isUploadRef(image.ref)) {
    const master = { width: image.width, height: image.height };
    sizes = [...LADDER_STEPS.filter((w) => w < master.width), master.width].map((w) => ({
      width: w,
      height: Math.max(1, Math.round((master.height * w) / master.width)),
      url: `/media/${image.ref}-${w}.webp`,
    }));
  } else {
    sizes = curatedSizes(image.width, image.height).map((s) => ({ ...s, url: curatedVariantUrl(image.ref, s.width) }));
  }
  if (sizes.length === 0) return null;
  const master = sizes[sizes.length - 1];
  const fallback = sizes.find((s) => s.width === 800) ?? master;
  return { src: fallback.url, srcset: sizes.map((s) => `${s.url} ${s.width}w`).join(", "), width: master.width, height: master.height, sizes };
}
