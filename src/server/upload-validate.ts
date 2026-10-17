/**
 * Header-only checks for uploaded photo variants (ADR-013, "Server validation").
 *
 * The Worker has 10 ms of CPU, so nothing here decodes pixels. It reads the RIFF container,
 * walks the chunks and reads the frame header, as laid out in RFC 9649 ("WebP Image Format").
 * Anything that is not a still, metadata-free WebP is refused with a reason: other formats,
 * animation, EXIF and XMP (the GPS location must not reach the server, even from a crafted
 * client), and bytes outside the chunks the format defines, where a polyglot would hide.
 *
 * A well-headed file can still fail to decode. That is accepted: photos are served with a
 * fixed type, `nosniff` and a sandbox CSP (ADR-015), so the worst case is a broken image.
 */

/** The existing per-variant CHECK on image_variants.bytes (migrations/0001_content.sql). */
export const MAX_VARIANT_BYTES = 1_048_576;

/** RFC 9649: canvas width × height must fit in 32 bits. */
const MAX_CANVAS_AREA = 2 ** 32 - 1;

export type OtherFormat = "jpeg" | "png" | "gif" | "heic" | "avif" | "markup" | "unknown";

export type WebpRefusal =
  /** Not a WebP at all; `format` says what it looked like. */
  | { reason: "not-webp"; format: OtherFormat }
  | { reason: "empty" }
  | { reason: "too-large" }
  /** The data ends inside a header or a chunk. */
  | { reason: "truncated" }
  /** The RIFF size field disagrees with the length: bytes appended or cut off. */
  | { reason: "riff-size" }
  /** An odd RIFF size, or a non-zero pad byte after an odd-sized chunk. */
  | { reason: "odd-size" }
  | { reason: "animated" }
  /** EXIF or XMP, flagged in VP8X or present as a chunk. */
  | { reason: "metadata"; chunk: "EXIF" | "XMP " }
  /** A chunk this format does not allow here, or a missing or repeated one. */
  | { reason: "bad-chunk"; chunk: string }
  /** The VP8, VP8L or VP8X header itself is malformed, or an ICC chunk is not an ICC profile. */
  | { reason: "bad-header"; chunk: "VP8 " | "VP8L" | "VP8X" | "ICCP" }
  /** VP8X canvas size differs from the image bitstream's size. */
  | { reason: "size-mismatch" };

export interface WebpInfo {
  width: number;
  height: number;
  /** As sharp reports it: the VP8X alpha flag in an extended file, else the VP8L alpha bit. */
  hasAlpha: boolean;
  lossless: boolean;
}

export type WebpCheck = ({ ok: true } & WebpInfo) | ({ ok: false } & WebpRefusal);

const refuse = (refusal: WebpRefusal): WebpCheck => ({ ok: false, ...refusal });

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Best guess at what a non-WebP file is, for the refusal message and the logs. */
export function sniffOtherFormat(b: Uint8Array): OtherFormat {
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  const gif = String.fromCharCode(...b.subarray(0, 6));
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (b.length >= 12 && fourcc(b, 4) === "ftyp") {
    const brand = fourcc(b, 8);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  // SVG, HTML and XML, possibly after a byte-order mark and whitespace.
  let i = starts(0xef, 0xbb, 0xbf) ? 3 : 0;
  while (i < b.length && i < 1024 && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (b[i] === 0x3c /* < */) return "markup";
  return "unknown";
}

/** RFC 9649 §2.5 and RFC 6386 §9.1: the key-frame header at the start of a VP8 chunk. */
function vp8Size(p: Uint8Array): { width: number; height: number } | null {
  if (p.length < 10) return null;
  const tag = u24(p, 0);
  const keyFrame = (tag & 1) === 0;
  const profile = (tag >> 1) & 7;
  const shown = (tag >> 4) & 1;
  const firstPartition = tag >>> 5;
  if (!keyFrame || profile > 3 || !shown || firstPartition >= p.length) return null;
  if (p[3] !== 0x9d || p[4] !== 0x01 || p[5] !== 0x2a) return null;
  // The top two bits of each are upscaling hints; libwebp ignores them for the size.
  const width = u16(p, 6) & 0x3fff;
  const height = u16(p, 8) & 0x3fff;
  return width && height ? { width, height } : null;
}

/** RFC 9649 §3.2: signature 0x2f, then 14-bit width − 1, 14-bit height − 1, alpha, version. */
function vp8lSize(p: Uint8Array): { width: number; height: number; alpha: boolean } | null {
  if (p.length < 5 || p[0] !== 0x2f) return null;
  const bits = u32(p, 1);
  if (bits >>> 29 !== 0) return null;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
}

interface Chunk {
  id: string;
  payload: Uint8Array;
}

/** Inspect one uploaded variant. Never throws; anything unexpected is a refusal. */
export function inspectWebp(bytes: Uint8Array): WebpCheck {
  if (bytes.length === 0) return refuse({ reason: "empty" });
  if (bytes.length > MAX_VARIANT_BYTES) return refuse({ reason: "too-large" });
  if (bytes.length < 12 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") {
    const format = sniffOtherFormat(bytes);
    // A file cut off inside "RIFF....WEBP" is a truncated WebP, not another format.
    const riffPrefix = "RIFF????WEBP";
    const looksLikeRiff = format === "unknown" && bytes.length < 12 && [...bytes].every((v, i) => riffPrefix[i] === "?" || v === riffPrefix.charCodeAt(i));
    return refuse(looksLikeRiff ? { reason: "truncated" } : { reason: "not-webp", format });
  }

  const riffSize = u32(bytes, 4);
  if (riffSize + 8 > bytes.length) return refuse({ reason: "truncated" });
  if (riffSize + 8 < bytes.length) return refuse({ reason: "riff-size" });
  if (riffSize % 2 !== 0) return refuse({ reason: "odd-size" });

  // Walk every chunk. Each is a FourCC, a 32-bit size and the payload, padded to even length.
  const chunks: Chunk[] = [];
  for (let at = 12; at < bytes.length; ) {
    if (at + 8 > bytes.length) return refuse({ reason: "truncated" });
    const id = fourcc(bytes, at);
    const size = u32(bytes, at + 4);
    const end = at + 8 + size;
    if (end > bytes.length) return refuse({ reason: "truncated" });
    if (size % 2 === 1) {
      if (end + 1 > bytes.length) return refuse({ reason: "truncated" });
      if (bytes[end] !== 0) return refuse({ reason: "odd-size" });
    }
    chunks.push({ id, payload: bytes.subarray(at + 8, end) });
    at = end + (size % 2);
  }

  // Refuse what must never be stored before judging the layout, so the reason is the useful one.
  for (const { id } of chunks) {
    if (id === "ANIM" || id === "ANMF") return refuse({ reason: "animated" });
    if (id === "EXIF" || id === "XMP ") return refuse({ reason: "metadata", chunk: id });
  }

  const [first, ...rest] = chunks;
  if (!first) return refuse({ reason: "truncated" });

  // Simple formats (RFC 9649 §2.5, §2.6): exactly one image chunk.
  if (first.id === "VP8 " || first.id === "VP8L") {
    if (rest.length > 0) return refuse({ reason: "bad-chunk", chunk: rest[0].id });
    return imageInfo(first);
  }
  if (first.id !== "VP8X") return refuse({ reason: "bad-chunk", chunk: first.id });

  // Extended format (RFC 9649 §2.7). Flags byte: Rsv(2) I L E X A R.
  const x = first.payload;
  if (x.length !== 10) return refuse({ reason: "bad-header", chunk: "VP8X" });
  const flags = x[0];
  // The RFC tells readers to ignore the reserved bits, but libwebp's demuxer (sharp,
  // Chromium) refuses such files, so storing one would store a broken image.
  if (flags & 0xc1) return refuse({ reason: "bad-header", chunk: "VP8X" });
  if (flags & 0x02) return refuse({ reason: "animated" });
  if (flags & 0x08) return refuse({ reason: "metadata", chunk: "EXIF" });
  if (flags & 0x04) return refuse({ reason: "metadata", chunk: "XMP " });
  const canvasWidth = u24(x, 4) + 1;
  const canvasHeight = u24(x, 7) + 1;
  if (canvasWidth * canvasHeight > MAX_CANVAS_AREA) return refuse({ reason: "bad-header", chunk: "VP8X" });

  // An ICC profile is allowed (Chromium's encoder always writes one), only where the flag
  // says so and only first. Then a still image: an optional ALPH followed by VP8, or a lone
  // VP8L. Nothing else, before or after.
  if (rest[0]?.id === "ICCP" && flags & 0x20) {
    if (!isIccProfile(rest[0].payload)) return refuse({ reason: "bad-header", chunk: "ICCP" });
    rest.shift();
  }
  let image: Chunk;
  if (rest[0]?.id === "ALPH") {
    if (rest[1]?.id !== "VP8 ") return refuse({ reason: "bad-chunk", chunk: rest[1]?.id ?? "ALPH" });
    image = rest[1];
    if (rest.length > 2) return refuse({ reason: "bad-chunk", chunk: rest[2].id });
  } else {
    if (rest[0]?.id !== "VP8 " && rest[0]?.id !== "VP8L") return refuse({ reason: "bad-chunk", chunk: rest[0]?.id ?? "VP8X" });
    image = rest[0];
    if (rest.length > 1) return refuse({ reason: "bad-chunk", chunk: rest[1].id });
  }

  const info = imageInfo(image);
  if (!info.ok) return info;
  if (info.width !== canvasWidth || info.height !== canvasHeight) return refuse({ reason: "size-mismatch" });
  // sharp (libvips) takes alpha from the VP8X flag, whatever the bitstream says.
  return { ...info, hasAlpha: (flags & 0x10) !== 0 };
}

/**
 * The fixed part of an ICC profile header (ICC.1): its own size, big-endian, equal to the
 * payload, and the "acsp" signature at offset 36. It keeps arbitrary bytes, such as HTML, out
 * of a chunk that is not image data; it does not validate the profile's tags.
 */
function isIccProfile(p: Uint8Array): boolean {
  return p.length >= 128 && u32be(p, 0) === p.length && fourcc(p, 36) === "acsp";
}

/** Size and alpha from the image chunk, as a simple file would report them. */
function imageInfo(chunk: Chunk): WebpCheck {
  if (chunk.id === "VP8 ") {
    const size = vp8Size(chunk.payload);
    return size ? { ok: true, ...size, hasAlpha: false, lossless: false } : refuse({ reason: "bad-header", chunk: "VP8 " });
  }
  const size = vp8lSize(chunk.payload);
  return size
    ? { ok: true, width: size.width, height: size.height, hasAlpha: size.alpha, lossless: true }
    : refuse({ reason: "bad-header", chunk: "VP8L" });
}

/** The width steps below the master (ADR-012 §2); the master is the widest variant. */
export const LADDER_STEPS = [400, 800, 1200] as const;
export const MASTER_MAX = { width: 1600, height: 2400 } as const;
export const MASTER_MIN_WIDTH = 320;
/**
 * Variants are scaled copies with rounded heights, so a height may be 1 % or 1 px off the
 * master's aspect, whichever is more. 1 % alone is under half a pixel once a panorama's
 * smallest variant is under 50 px tall.
 */
export const ASPECT_TOLERANCE = 0.01;

export type LadderRefusal =
  | { reason: "no-variants" }
  /** A width or height that is not a whole number of pixels, at least 1. */
  | { reason: "bad-size" }
  | { reason: "too-many-variants" }
  /** Widths not exactly the steps below the master plus the master, in increasing order. */
  | { reason: "wrong-widths"; expected: number[] }
  | { reason: "master-too-small" }
  | { reason: "master-too-large" }
  | { reason: "aspect-mismatch"; width: number };

/**
 * The variants of one upload, in the order they were sent. Checks only arithmetic on the
 * header sizes; the total byte cap belongs to the upload handler (ADR-012 Amendment 1 §4).
 */
export function checkLadder(variants: readonly { width: number; height: number }[]): { ok: true } | ({ ok: false } & LadderRefusal) {
  if (variants.length === 0) return { ok: false, reason: "no-variants" };
  if (variants.length > LADDER_STEPS.length + 1) return { ok: false, reason: "too-many-variants" };
  if (!variants.every((v) => Number.isInteger(v.width) && Number.isInteger(v.height) && v.width >= 1 && v.height >= 1)) {
    return { ok: false, reason: "bad-size" };
  }
  const master = variants[variants.length - 1];
  if (master.width < MASTER_MIN_WIDTH) return { ok: false, reason: "master-too-small" };
  if (master.width > MASTER_MAX.width || master.height > MASTER_MAX.height) return { ok: false, reason: "master-too-large" };

  const expected = [...LADDER_STEPS.filter((w) => w < master.width), master.width];
  if (variants.length !== expected.length || variants.some((v, i) => v.width !== expected[i])) {
    return { ok: false, reason: "wrong-widths", expected };
  }
  for (const v of variants) {
    // The height w·H/W would have, compared without dividing: |w·H − W·h| ≤ W · max(1 %·h, 1 px).
    if (Math.abs(v.width * master.height - master.width * v.height) > master.width * Math.max(ASPECT_TOLERANCE * v.height, 1)) {
      return { ok: false, reason: "aspect-mismatch", width: v.width };
    }
  }
  return { ok: true };
}
