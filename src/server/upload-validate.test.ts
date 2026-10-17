import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkLadder, inspectWebp, MAX_VARIANT_BYTES, type WebpCheck } from "./upload-validate";

// Every WebP here is real encoder output from tests/fixtures/webp (scripts/make-webp-corpus.ts).
// Broken files are made by cutting, flipping or re-wrapping those bytes, never typed by hand.
const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "../../tests/fixtures/webp", `${name}.webp`)));

const LOSSY = fixture("sharp-400x300-q75"); // RIFF + VP8
const LOSSLESS = fixture("sharp-400x300-lossless"); // RIFF + VP8L
const LOSSY_ALPHA = fixture("sharp-alpha-q75-alphaq50"); // RIFF + VP8X + ALPH + VP8
const WITH_ICC = fixture("chromium-400x300-q75"); // RIFF + VP8X + ICCP + VP8
const ANIMATED = fixture("sharp-refuse-animated");
const WITH_EXIF = fixture("sharp-refuse-exif");
const WITH_XMP = fixture("sharp-refuse-xmp");

const ascii = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

interface Chunk {
  id: string;
  payload: Uint8Array;
}

/** The chunks of a real file, as the RIFF layout stores them. */
function chunksOf(file: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let at = 12; at < file.length; ) {
    const size = view.getUint32(at + 4, true);
    out.push({ id: new TextDecoder().decode(file.subarray(at, at + 4)), payload: file.slice(at + 8, at + 8 + size) });
    at += 8 + size + (size % 2);
  }
  return out;
}

/** A RIFF/WEBP container around the given chunks, with correct sizes and zero padding. */
function riff(chunks: Chunk[]): Uint8Array {
  const body = concat(...chunks.map((c) => concat(ascii(c.id), u32(c.payload.length), c.payload, new Uint8Array(c.payload.length % 2))));
  return concat(ascii("RIFF"), u32(body.length + 4), ascii("WEBP"), body);
}

const chunk = (file: Uint8Array, id: string) => {
  const found = chunksOf(file).find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} chunk`);
  return found;
};

const withByte = (file: Uint8Array, at: number, value: number) => {
  const copy = file.slice();
  copy[at] = value;
  return copy;
};

const refusal = (r: WebpCheck) => (r.ok ? "accepted" : r.reason);

describe("inspectWebp: accepted files", () => {
  it("reads the size of a simple lossy file (VP8)", () => {
    expect(inspectWebp(LOSSY)).toEqual({ ok: true, width: 400, height: 300, hasAlpha: false, lossless: false });
  });

  it("reads the size of a simple lossless file (VP8L)", () => {
    expect(inspectWebp(LOSSLESS)).toEqual({ ok: true, width: 400, height: 300, hasAlpha: false, lossless: true });
  });

  it("reads an extended file with an alpha chunk (VP8X + ALPH + VP8)", () => {
    expect(chunksOf(LOSSY_ALPHA).map((c) => c.id)).toEqual(["VP8X", "ALPH", "VP8 "]);
    expect(inspectWebp(LOSSY_ALPHA)).toEqual({ ok: true, width: 321, height: 479, hasAlpha: true, lossless: false });
  });

  it("accepts an ICC profile, as Chromium's encoder writes one", () => {
    expect(chunksOf(WITH_ICC).map((c) => c.id)).toEqual(["VP8X", "ICCP", "VP8 "]);
    expect(inspectWebp(WITH_ICC)).toMatchObject({ ok: true, width: 400, height: 300 });
  });

  it("reads the extremes: 1 × 1 and 16383 × 1", () => {
    expect(inspectWebp(fixture("sharp-1x1-q75"))).toMatchObject({ ok: true, width: 1, height: 1 });
    expect(inspectWebp(fixture("sharp-16383x1-lossless"))).toMatchObject({ ok: true, width: 16383, height: 1 });
  });

  it("accepts a file exactly at the per-variant limit but not one byte over", () => {
    // An unknown chunk would be refused, so grow the VP8 payload: trailing bytes in a VP8
    // frame are not read by the header check (decoding is not the validator's job).
    const vp8 = chunk(LOSSY, "VP8 ");
    const grow = (total: number) => riff([{ id: "VP8 ", payload: concat(vp8.payload, new Uint8Array(total - 20 - vp8.payload.length)) }]);
    expect(grow(MAX_VARIANT_BYTES).length).toBe(MAX_VARIANT_BYTES);
    expect(inspectWebp(grow(MAX_VARIANT_BYTES))).toMatchObject({ ok: true });
    expect(refusal(inspectWebp(grow(MAX_VARIANT_BYTES + 2)))).toBe("too-large");
  });
});

describe("inspectWebp: other formats are refused by their magic", () => {
  it.each([
    ["jpeg", () => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toBuffer()],
    ["png", () => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer()],
    ["gif", () => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).gif().toBuffer()],
    ["avif", () => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).avif().toBuffer()],
  ])("%s", async (format, make) => {
    expect(inspectWebp(new Uint8Array(await make()))).toEqual({ ok: false, reason: "not-webp", format });
  });

  it("HEIC, by its ftyp brand", () => {
    // The ISO-BMFF box header only; sharp's prebuilt libvips cannot encode HEVC.
    const heic = concat(u32(0x18000000), ascii("ftypheic"), new Uint8Array(4), ascii("mif1heic"));
    expect(inspectWebp(heic)).toEqual({ ok: false, reason: "not-webp", format: "heic" });
  });

  it.each([
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["HTML", "<!doctype html><script>alert(1)</script>"],
    ["HTML after a BOM and whitespace", "﻿ \n\t<html><body onload=alert(1)>"],
    ["XML", '<?xml version="1.0"?><svg/>'],
  ])("%s", (_, text) => {
    expect(inspectWebp(ascii(text))).toEqual({ ok: false, reason: "not-webp", format: "markup" });
  });

  it("a RIFF file that is not WebP (WAVE)", () => {
    const wave = concat(ascii("RIFF"), u32(4), ascii("WAVE"));
    expect(inspectWebp(wave)).toEqual({ ok: false, reason: "not-webp", format: "unknown" });
  });

  it("an empty upload", () => {
    expect(refusal(inspectWebp(new Uint8Array(0)))).toBe("empty");
  });
});

describe("inspectWebp: polyglots (RIFF…WEBP plus HTML)", () => {
  const html = ascii("<html><script>alert(document.cookie)</script></html>");

  it("HTML appended after a valid file", () => {
    expect(refusal(inspectWebp(concat(LOSSY, html)))).toBe("riff-size");
  });

  it("HTML appended with the RIFF size raised to cover it", () => {
    const polyglot = concat(LOSSY, html, new Uint8Array(html.length % 2));
    polyglot.set(u32(polyglot.length - 8), 4);
    expect(inspectWebp(polyglot).ok).toBe(false);
  });

  it("HTML in a chunk of its own after the image", () => {
    expect(inspectWebp(riff([chunk(LOSSY, "VP8 "), { id: "HTML", payload: html }]))).toEqual({ ok: false, reason: "bad-chunk", chunk: "HTML" });
  });

  it("HTML in an unknown chunk inside an extended file", () => {
    const [vp8x, alph, vp8] = chunksOf(LOSSY_ALPHA);
    expect(refusal(inspectWebp(riff([vp8x, { id: "abcd", payload: html }, alph, vp8])))).toBe("bad-chunk");
    expect(refusal(inspectWebp(riff([vp8x, alph, vp8, { id: "abcd", payload: html }])))).toBe("bad-chunk");
  });

  it("HTML straight after the WEBP signature", () => {
    const polyglot = concat(ascii("RIFF"), u32(4 + html.length), ascii("WEBP"), html);
    expect(inspectWebp(polyglot).ok).toBe(false);
  });
});

describe("inspectWebp: container damage", () => {
  it("every truncation of a valid file is refused", () => {
    for (const file of [LOSSY, LOSSLESS, LOSSY_ALPHA, WITH_ICC]) {
      for (let length = 0; length < file.length; length++) {
        const result = inspectWebp(file.subarray(0, length));
        expect(result.ok, `length ${length}`).toBe(false);
      }
    }
  });

  it("names a cut-off file as truncated, including inside the RIFF header", () => {
    expect(refusal(inspectWebp(LOSSY.subarray(0, LOSSY.length - 10)))).toBe("truncated");
    expect(refusal(inspectWebp(LOSSY.subarray(0, 7)))).toBe("truncated");
    expect(refusal(inspectWebp(LOSSY.subarray(0, 12)))).toBe("truncated");
  });

  it("a RIFF size that is too small or too large", () => {
    const size = LOSSY.length - 8;
    expect(refusal(inspectWebp(concat(LOSSY.subarray(0, 4), u32(size - 2), LOSSY.subarray(8))))).toBe("riff-size");
    expect(refusal(inspectWebp(concat(LOSSY.subarray(0, 4), u32(size + 2), LOSSY.subarray(8))))).toBe("truncated");
    expect(refusal(inspectWebp(concat(LOSSY.subarray(0, 4), u32(0xffffffff), LOSSY.subarray(8))))).toBe("truncated");
  });

  it("an odd RIFF size", () => {
    const odd = concat(LOSSY, new Uint8Array([0]));
    odd.set(u32(odd.length - 8), 4);
    expect(refusal(inspectWebp(odd))).toBe("odd-size");
  });

  it("an odd-sized chunk: needs its pad byte, and the pad must be zero", () => {
    const vp8 = chunk(LOSSY, "VP8 ");
    const oddVp8 = { id: "VP8 ", payload: vp8.payload.length % 2 ? vp8.payload : concat(vp8.payload, new Uint8Array(1)) };
    const good = riff([oddVp8]);
    expect(inspectWebp(good)).toMatchObject({ ok: true, width: 400 });
    expect(refusal(inspectWebp(withByte(good, good.length - 1, 0x3c)))).toBe("odd-size");
    const unpadded = good.subarray(0, good.length - 1).slice();
    unpadded.set(u32(unpadded.length - 8), 4);
    expect(refusal(inspectWebp(unpadded))).toBe("odd-size");
  });

  it("a chunk size that runs past the end", () => {
    const file = LOSSY.slice();
    file.set(u32(LOSSY.length), 16);
    expect(refusal(inspectWebp(file))).toBe("truncated");
  });

  it("a file with no chunks", () => {
    expect(refusal(inspectWebp(concat(ascii("RIFF"), u32(4), ascii("WEBP"))))).toBe("truncated");
  });
});

describe("inspectWebp: refused content", () => {
  it("animation", () => {
    expect(refusal(inspectWebp(ANIMATED))).toBe("animated");
  });

  it("the animation flag alone, without frames", () => {
    const [vp8x, alph, vp8] = chunksOf(LOSSY_ALPHA);
    const flagged = { id: "VP8X", payload: withByte(vp8x.payload, 0, vp8x.payload[0] | 0x02) };
    expect(refusal(inspectWebp(riff([flagged, alph, vp8])))).toBe("animated");
  });

  it("an EXIF chunk, and an XMP chunk", () => {
    expect(inspectWebp(WITH_EXIF)).toEqual({ ok: false, reason: "metadata", chunk: "EXIF" });
    expect(inspectWebp(WITH_XMP)).toEqual({ ok: false, reason: "metadata", chunk: "XMP " });
  });

  it("an EXIF chunk whose VP8X flag was cleared by a crafted client", () => {
    const [vp8x, ...rest] = chunksOf(WITH_EXIF);
    const unflagged = { id: "VP8X", payload: withByte(vp8x.payload, 0, vp8x.payload[0] & ~0x08) };
    expect(inspectWebp(riff([unflagged, ...rest]))).toEqual({ ok: false, reason: "metadata", chunk: "EXIF" });
  });

  it("an EXIF chunk appended to a simple file", () => {
    expect(inspectWebp(riff([chunk(LOSSY, "VP8 "), chunk(WITH_EXIF, "EXIF")]))).toEqual({ ok: false, reason: "metadata", chunk: "EXIF" });
  });

  it("the EXIF or XMP flag without a chunk", () => {
    const [vp8x, alph, vp8] = chunksOf(LOSSY_ALPHA);
    for (const bit of [0x08, 0x04]) {
      const flagged = { id: "VP8X", payload: withByte(vp8x.payload, 0, vp8x.payload[0] | bit) };
      expect(refusal(inspectWebp(riff([flagged, alph, vp8])))).toBe("metadata");
    }
  });
});

describe("inspectWebp: chunk layout and headers", () => {
  const [vp8x, alph, vp8] = chunksOf(LOSSY_ALPHA);

  it("a second image chunk", () => {
    expect(refusal(inspectWebp(riff([chunk(LOSSY, "VP8 "), chunk(LOSSY, "VP8 ")])))).toBe("bad-chunk");
    expect(refusal(inspectWebp(riff([vp8x, alph, vp8, vp8])))).toBe("bad-chunk");
  });

  it("ALPH without VP8, or before VP8L", () => {
    expect(refusal(inspectWebp(riff([vp8x, alph])))).toBe("bad-chunk");
    expect(refusal(inspectWebp(riff([vp8x, alph, chunk(LOSSLESS, "VP8L")])))).toBe("bad-chunk");
  });

  it("VP8X with no image", () => {
    expect(refusal(inspectWebp(riff([vp8x])))).toBe("bad-chunk");
  });

  it("an ICC chunk without its flag, or after the image", () => {
    const [iccX, iccp, iccVp8] = chunksOf(WITH_ICC);
    const unflagged = { id: "VP8X", payload: withByte(iccX.payload, 0, iccX.payload[0] & ~0x20) };
    expect(refusal(inspectWebp(riff([unflagged, iccp, iccVp8])))).toBe("bad-chunk");
    expect(refusal(inspectWebp(riff([iccX, iccVp8, iccp])))).toBe("bad-chunk");
  });

  it("a first chunk that is not VP8, VP8L or VP8X", () => {
    expect(inspectWebp(riff([alph, vp8]))).toEqual({ ok: false, reason: "bad-chunk", chunk: "ALPH" });
  });

  it("VP8X of the wrong length", () => {
    expect(refusal(inspectWebp(riff([{ id: "VP8X", payload: vp8x.payload.subarray(0, 8) }, alph, vp8])))).toBe("bad-header");
  });

  it("a VP8X canvas that differs from the image", () => {
    const wider = vp8x.payload.slice();
    wider[4] += 1;
    expect(refusal(inspectWebp(riff([{ id: "VP8X", payload: wider }, alph, vp8])))).toBe("size-mismatch");
  });

  it("a VP8X canvas over 2^32 − 1 pixels", () => {
    const huge = vp8x.payload.slice();
    huge.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 4);
    expect(inspectWebp(riff([{ id: "VP8X", payload: huge }, alph, vp8]))).toEqual({ ok: false, reason: "bad-header", chunk: "VP8X" });
  });

  it("VP8: a broken start code, an inter frame, a hidden frame, a bad profile, zero size", () => {
    const p = chunk(LOSSY, "VP8 ").payload;
    const broken = [withByte(p, 3, 0x9c), withByte(p, 0, p[0] | 0x01), withByte(p, 0, p[0] & ~0x10), withByte(p, 0, (p[0] & ~0x0e) | 0x08), withByte(withByte(p, 6, 0), 7, 0)];
    for (const payload of broken) {
      expect(inspectWebp(riff([{ id: "VP8 ", payload }]))).toEqual({ ok: false, reason: "bad-header", chunk: "VP8 " });
    }
  });

  it("VP8: a first partition longer than the frame", () => {
    const p = chunk(LOSSY, "VP8 ").payload.slice();
    p[2] = 0xff; // first partition size bits 13..18
    expect(refusal(inspectWebp(riff([{ id: "VP8 ", payload: p }])))).toBe("bad-header");
  });

  it("VP8L: a wrong signature or a non-zero version", () => {
    const p = chunk(LOSSLESS, "VP8L").payload;
    for (const payload of [withByte(p, 0, 0x2e), withByte(p, 4, p[4] | 0x20)]) {
      expect(inspectWebp(riff([{ id: "VP8L", payload }]))).toEqual({ ok: false, reason: "bad-header", chunk: "VP8L" });
    }
  });

  it("a header chunk too short to read", () => {
    expect(refusal(inspectWebp(riff([{ id: "VP8 ", payload: new Uint8Array(9) }])))).toBe("bad-header");
    expect(refusal(inspectWebp(riff([{ id: "VP8L", payload: new Uint8Array([0x2f, 0, 0, 0]) }])))).toBe("bad-header");
  });
});

describe("inspectWebp: fuzzing", () => {
  const REASONS = new Set(["not-webp", "empty", "too-large", "truncated", "riff-size", "odd-size", "animated", "metadata", "bad-chunk", "bad-header", "size-mismatch"]);
  const seeds = [LOSSY, LOSSLESS, LOSSY_ALPHA, WITH_ICC, ANIMATED, WITH_EXIF];

  it("1,000 random truncations and bit flips never throw and always give a reason or a size", () => {
    let state = 0x9e3779b9;
    const rand = (n: number) => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);
    for (let i = 0; i < 1000; i++) {
      const base = seeds[rand(seeds.length)];
      let bytes = base.slice();
      if (i % 2 === 0) bytes = bytes.subarray(0, rand(bytes.length + 1));
      // Most damage lands in the headers, where the parser works; some anywhere.
      for (let flips = 1 + rand(4); flips > 0; flips--) {
        if (bytes.length === 0) break;
        const at = rand(4) === 0 ? rand(bytes.length) : rand(Math.min(bytes.length, 64));
        bytes[at] ^= 1 << rand(8);
      }
      const result = inspectWebp(bytes);
      if (result.ok) {
        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
        expect(result.width).toBeLessThanOrEqual(16384);
        expect(result.height).toBeLessThanOrEqual(16384);
      } else {
        expect(REASONS.has(result.reason), result.reason).toBe(true);
      }
    }
  });
});

describe("checkLadder", () => {
  const ladder = (...sizes: [number, number][]) => sizes.map(([width, height]) => ({ width, height }));

  it("accepts the full ladder and the shorter ones a smaller photo gives", () => {
    expect(checkLadder(ladder([400, 300], [800, 600], [1200, 900], [1600, 1200]))).toEqual({ ok: true });
    expect(checkLadder(ladder([400, 600], [800, 1200], [1200, 1800], [1600, 2400]))).toEqual({ ok: true });
    expect(checkLadder(ladder([400, 267], [800, 533], [1000, 667]))).toEqual({ ok: true });
    expect(checkLadder(ladder([400, 300]))).toEqual({ ok: true });
    expect(checkLadder(ladder([400, 300], [401, 301]))).toEqual({ ok: true });
    expect(checkLadder(ladder([320, 240]))).toEqual({ ok: true });
  });

  it("refuses no variants or more than four", () => {
    expect(checkLadder([])).toMatchObject({ ok: false, reason: "no-variants" });
    expect(checkLadder(ladder([400, 300], [800, 600], [1200, 900], [1600, 1200], [1600, 1200]))).toMatchObject({ ok: false, reason: "too-many-variants" });
  });

  it("refuses a master under 320 wide or over 1600 × 2400", () => {
    expect(checkLadder(ladder([319, 400]))).toMatchObject({ ok: false, reason: "master-too-small" });
    expect(checkLadder(ladder([400, 300], [800, 600], [1200, 900], [1601, 1200]))).toMatchObject({ ok: false, reason: "master-too-large" });
    expect(checkLadder(ladder([400, 601], [800, 1201], [1200, 1801], [1600, 2401]))).toMatchObject({ ok: false, reason: "master-too-large" });
  });

  it("refuses widths out of order, missing, repeated or off the steps", () => {
    const wrong = { ok: false, reason: "wrong-widths", expected: [400, 800, 1200, 1600] };
    expect(checkLadder(ladder([800, 600], [400, 300], [1200, 900], [1600, 1200]))).toEqual(wrong);
    expect(checkLadder(ladder([400, 300], [1200, 900], [1600, 1200]))).toEqual(wrong);
    expect(checkLadder(ladder([400, 300], [400, 300], [1200, 900], [1600, 1200]))).toEqual(wrong);
    expect(checkLadder(ladder([500, 375], [800, 600], [1200, 900], [1600, 1200]))).toEqual(wrong);
    expect(checkLadder(ladder([1600, 1200]))).toEqual(wrong);
  });

  it("refuses a variant whose aspect ratio is more than 1 % off the master's", () => {
    expect(checkLadder(ladder([400, 303], [800, 600], [1200, 900], [1600, 1200]))).toEqual({ ok: true });
    expect(checkLadder(ladder([400, 304], [800, 600], [1200, 900], [1600, 1200]))).toEqual({ ok: false, reason: "aspect-mismatch", width: 400 });
    expect(checkLadder(ladder([400, 300], [800, 300], [1200, 900], [1600, 1200]))).toEqual({ ok: false, reason: "aspect-mismatch", width: 800 });
  });
});
