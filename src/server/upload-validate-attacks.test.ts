/**
 * Tester (M6.5): attacks on inspectWebp and checkLadder beyond the author's tests.
 * Report: ~/Vault/Projects/dagens-menu/tester/2026-10-17-m6-validator-blob-hex.md
 *
 * Every file starts from real encoder output in tests/fixtures/webp and is re-wrapped.
 * Tests marked "TESTER FINDING" fail on purpose until the finding is fixed or waived.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkLadder, inspectWebp, LADDER_STEPS, type WebpCheck } from "./upload-validate";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "../../tests/fixtures/webp", `${name}.webp`)));
const ascii = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

interface Chunk {
  id: string;
  payload: Uint8Array;
}
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
const chunkBytes = (c: Chunk) => concat(ascii(c.id), u32(c.payload.length), c.payload, new Uint8Array(c.payload.length % 2));
function riff(chunks: Chunk[]): Uint8Array {
  const body = concat(...chunks.map(chunkBytes));
  return concat(ascii("RIFF"), u32(body.length + 4), ascii("WEBP"), body);
}
function vp8x(flags: number, width: number, height: number): Chunk {
  const p = new Uint8Array(10);
  p[0] = flags;
  for (const [at, v] of [
    [4, width - 1],
    [7, height - 1],
  ]) {
    p[at] = v & 0xff;
    p[at + 1] = (v >> 8) & 0xff;
    p[at + 2] = (v >> 16) & 0xff;
  }
  return { id: "VP8X", payload: p };
}
const find = (file: Uint8Array, id: string) => {
  const c = chunksOf(file).find((x) => x.id === id);
  if (!c) throw new Error(`no ${id}`);
  return c;
};

const LOSSY = fixture("sharp-400x300-q75");
const LOSSLESS = fixture("sharp-400x300-lossless");
const ALPHA_LOSSY = fixture("sharp-alpha-q75-alphaq50"); // VP8X + ALPH + VP8, 321 × 479
const ALPHA_LOSSLESS = fixture("sharp-alpha-lossless"); // VP8L with the alpha bit, 321 × 479
const WITH_ICC = fixture("chromium-400x300-q75");
const VP8 = find(LOSSY, "VP8 ");
const VP8L = find(LOSSLESS, "VP8L");
const VP8L_ALPHA = find(ALPHA_LOSSLESS, "VP8L");
const ALPH = find(ALPHA_LOSSY, "ALPH");
const VP8_OF_ALPHA = find(ALPHA_LOSSY, "VP8 ");
const HTML = ascii("<!doctype html><html><body><script>alert(document.domain)</script></body></html>");

const safely = (bytes: Uint8Array): WebpCheck | "threw" => {
  try {
    return inspectWebp(bytes);
  } catch {
    return "threw";
  }
};

/** What sharp (libvips + libwebp) says, or null when it cannot read the file. */
async function sharpSays(bytes: Uint8Array) {
  try {
    const m = await sharp(bytes).metadata();
    return { width: m.width, height: m.height, hasAlpha: m.hasAlpha };
  } catch {
    return null;
  }
}

describe("tester: inputs that are views, shared or pooled", () => {
  it("a Uint8Array view with byteOffset ≠ 0 inside a buffer full of HTML reads only the view", () => {
    const outer = concat(HTML, LOSSY, HTML);
    const view = outer.subarray(HTML.length, HTML.length + LOSSY.length);
    expect(view.byteOffset).toBeGreaterThan(0);
    expect(inspectWebp(view)).toEqual(inspectWebp(LOSSY));
    // A view one byte too long sees the trailing "<" and must be refused.
    expect(inspectWebp(outer.subarray(HTML.length, HTML.length + LOSSY.length + 1)).ok).toBe(false);
  });

  it("a SharedArrayBuffer-backed array and a pooled Buffer give the same answer", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(LOSSY.length));
    shared.set(LOSSY);
    expect(inspectWebp(shared)).toEqual(inspectWebp(LOSSY));
    const small = Buffer.from(fixture("sharp-1x1-q75")); // small enough to come from the Buffer pool
    expect(inspectWebp(small)).toEqual({ ok: true, width: 1, height: 1, hasAlpha: false, lossless: false });
  });
});

describe("tester: size fields near 2^32", () => {
  const sizes = [0xffffffff, 0xfffffffe, 0xfffffff8, 0x80000000, 0x7fffffff, 0x7ffffffe];

  it("a RIFF size near 2^32 is refused without throwing", () => {
    for (const s of sizes) {
      const f = LOSSY.slice();
      f.set(u32(s), 4);
      expect(safely(f)).toMatchObject({ ok: false, reason: "truncated" });
    }
  });

  it("a chunk size near 2^32 in every chunk position is refused without throwing", () => {
    for (const file of [LOSSY, ALPHA_LOSSY, WITH_ICC]) {
      let at = 12;
      for (const c of chunksOf(file)) {
        for (const s of sizes) {
          const f = file.slice();
          f.set(u32(s), at + 4);
          const r = safely(f);
          expect(r).not.toBe("threw");
          expect((r as WebpCheck).ok).toBe(false);
        }
        at += 8 + c.payload.length + (c.payload.length % 2);
      }
    }
  });

  it("thousands of zero-size chunks end the walk (no loop) and are refused", () => {
    const empties = Array.from({ length: 20000 }, () => ({ id: "JUNK", payload: new Uint8Array(0) }));
    const r = safely(riff([VP8, ...empties]));
    expect(r).toMatchObject({ ok: false, reason: "bad-chunk" });
  });

  it("the largest VP8X canvas that fits 2^32 − 1, with a small image, is a size mismatch", () => {
    expect(safely(riff([vp8x(0, 65536, 65535), VP8]))).toMatchObject({ ok: false, reason: "size-mismatch" });
    expect(safely(riff([vp8x(0, 2 ** 24, 2 ** 24), VP8]))).toMatchObject({ ok: false, reason: "bad-header" });
  });
});

describe("tester: structured fuzzing (random chunk sequences)", () => {
  // Random but plausible files: the real chunks in random order, with random VP8X flags.
  let seed = 0x5eed;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pool = (): Chunk => {
    switch (rand(12)) {
      case 0:
        return vp8x(rand(256), 400, 300);
      case 1:
        return vp8x(rand(2) ? 0x10 : 0x20, 321, 479);
      case 2:
        return VP8;
      case 3:
        return VP8L;
      case 4:
        return ALPH;
      case 5:
        return VP8_OF_ALPHA;
      case 6:
        return find(WITH_ICC, "ICCP");
      case 7:
        return { id: ["EXIF", "XMP ", "ANIM", "ANMF"][rand(4)], payload: new Uint8Array(rand(5)) };
      case 8:
        return { id: "ICCP", payload: HTML };
      case 9:
        return { id: ["exif", "XMP\0", "JUNK", "VP8 "][rand(4)], payload: HTML.subarray(0, rand(HTML.length)) };
      case 10:
        return VP8L_ALPHA;
      default:
        return vp8x(rand(2) ? 0x30 : 0, 400, 300);
    }
  };
  const files = Array.from({ length: 5000 }, () => riff(Array.from({ length: 1 + rand(4) }, pool)));

  it("never throws, and anything accepted has no animation, EXIF or XMP chunk or flag and an image chunk", () => {
    for (const f of files) {
      const r = safely(f);
      expect(r).not.toBe("threw");
      if (r === "threw" || !r.ok) continue;
      const ids = chunksOf(f).map((c) => c.id);
      expect(ids.filter((id) => ["ANIM", "ANMF", "EXIF", "XMP "].includes(id))).toEqual([]);
      expect(ids.some((id) => id === "VP8 " || id === "VP8L")).toBe(true);
      if (ids[0] === "VP8X") expect(chunksOf(f)[0].payload[0] & 0x0e).toBe(0);
    }
  });

  it("anything accepted has the width and height sharp reads (and sharp can read it)", async () => {
    const accepted = files.filter((f) => inspectWebp(f).ok);
    expect(accepted.length).toBeGreaterThan(20);
    const seen = new Set<string>();
    const mismatches: string[] = [];
    for (const f of accepted) {
      const key = chunksOf(f)
        .map((c) => (c.id === "VP8X" ? `VP8X:${c.payload[0]}` : `${c.id}:${c.payload.length}`))
        .join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const r = inspectWebp(f) as WebpCheck & { ok: true };
      const s = await sharpSays(f);
      if (!s || s.width !== r.width || s.height !== r.height) mismatches.push(`${key} → ours ${r.width}×${r.height}, sharp ${s ? `${s.width}×${s.height}` : "cannot read"}`);
    }
    // TESTER FINDING (Low): VP8X reserved flag bits are accepted; sharp cannot read those files.
    expect(mismatches).toEqual([]);
  }, 60_000);
});

describe("tester: agreement with sharp on unusual but parseable files", () => {
  it("VP8 upscaling bits: the size ignores them, like libwebp", async () => {
    const p = VP8.payload.slice();
    p[7] |= 0xc0;
    p[9] |= 0x40;
    const f = riff([{ id: "VP8 ", payload: p }]);
    expect(inspectWebp(f)).toMatchObject({ ok: true, width: 400, height: 300 });
    expect(await sharpSays(f)).toMatchObject({ width: 400, height: 300 });
  });

  it("VP8X reserved bytes 1–3 set: accepted, and sharp reads it", async () => {
    const x = vp8x(0, 400, 300);
    x.payload.set([0xff, 0xff, 0xff], 1);
    const f = riff([x, VP8]);
    expect(inspectWebp(f)).toMatchObject({ ok: true, width: 400, height: 300 });
    expect(await sharpSays(f)).toMatchObject({ width: 400, height: 300 });
  });

  // TESTER FINDING (Low): libwebp's demuxer (used by libvips/sharp, and by Chromium's decoder)
  // treats any flag outside ALPHA|ANIM|ICCP|EXIF|XMP (0x3e) as an invalid bitstream. The
  // validator ignores them as RFC 9649 tells readers to, so it stores a file nothing decodes.
  it.each([0x01, 0x40, 0x80])("VP8X reserved flag bit %i: refused, since sharp cannot read the file", async (bit) => {
    const f = riff([vp8x(bit, 400, 300), VP8]);
    expect(await sharpSays(f)).toBeNull();
    expect(inspectWebp(f).ok).toBe(false);
  });

  // TESTER FINDING (Low): hasAlpha is not "equal to sharp's metadata()" when the VP8X alpha flag
  // disagrees with the bitstream. libvips takes hasAlpha from the VP8X flag (demux feature flags).
  it.each([
    ["VP8X without L + ALPH + VP8", () => riff([vp8x(0x00, 321, 479), ALPH, VP8_OF_ALPHA])],
    ["VP8X with L + VP8L without its alpha bit", () => riff([vp8x(0x10, 400, 300), VP8L])],
    ["VP8X without L + VP8L with its alpha bit", () => riff([vp8x(0x00, 321, 479), VP8L_ALPHA])],
    ["VP8X with L + VP8 and no ALPH", () => riff([vp8x(0x10, 400, 300), VP8])],
  ])("hasAlpha equals sharp's: %s", async (_, make) => {
    const f = make();
    const ours = inspectWebp(f);
    const theirs = await sharpSays(f);
    expect(theirs).not.toBeNull();
    expect(ours.ok).toBe(true);
    if (ours.ok && theirs) expect({ width: ours.width, height: ours.height, hasAlpha: ours.hasAlpha }).toEqual(theirs);
  });
});

describe("tester: HTML outside the image bitstream", () => {
  // TESTER FINDING (Low): the ICCP payload is not checked at all, so a VP8X file can carry up to
  // ~1 MiB of arbitrary bytes (HTML, a second image, text) in a chunk that is not image data.
  // An ICC profile starts with its own size (big-endian) and has "acsp" at offset 36.
  it("an ICCP chunk holding HTML instead of an ICC profile is refused", () => {
    const f = riff([vp8x(0x20, 400, 300), { id: "ICCP", payload: HTML }, VP8]);
    expect(inspectWebp(f).ok).toBe(false);
  });

  it("the real Chromium ICC profile is an ICC profile (what a check would accept)", () => {
    const icc = find(WITH_ICC, "ICCP").payload;
    expect(new DataView(icc.buffer, icc.byteOffset).getUint32(0)).toBe(icc.length);
    expect(new TextDecoder().decode(icc.subarray(36, 40))).toBe("acsp");
  });

  it("markup at the very start of a view is never accepted, whatever follows", () => {
    for (const prefix of ["<", " <", "﻿<svg", "<?xml"]) {
      expect(inspectWebp(concat(ascii(prefix), LOSSY)).ok).toBe(false);
    }
  });
});

describe("tester: checkLadder", () => {
  /** The ladder an honest client makes: each height rounded from the master's aspect. */
  const ladder = (W: number, H: number, round: (x: number) => number = Math.round) => [
    ...LADDER_STEPS.filter((w) => w < W).map((w) => ({ width: w, height: Math.max(1, round((H * w) / W)) })),
    { width: W, height: H },
  ];

  it("accepts an aspect difference of exactly 1 % (no floating-point loss at the boundary)", () => {
    // 400 × 100 against 1600 × 396: |400·396 − 1600·100| = 1600 = 1 % of 1600·100.
    expect(checkLadder([{ width: 400, height: 100 }, { width: 800, height: 198 }, { width: 1200, height: 297 }, { width: 1600, height: 396 }])).toEqual({ ok: true });
    expect(checkLadder([{ width: 400, height: 101 }, { width: 800, height: 198 }, { width: 1200, height: 297 }, { width: 1600, height: 396 }]).ok).toBe(false);
  });

  it("accepts the honest ladder for ordinary photos of every master width", () => {
    for (let W = 320; W <= 1600; W++) for (const ratio of [4 / 3, 3 / 2, 16 / 9, 1, 3 / 4, 2 / 3, 9 / 16]) {
      const H = Math.round(W / ratio);
      if (H > 2400) continue;
      expect(checkLadder(ladder(W, H)), `${W}×${H}`).toEqual({ ok: true });
    }
  });

  // TESTER FINDING (Medium): a 1 % tolerance on the ratio is less than half a pixel once a
  // variant is under 50 px tall, so correctly rounded panoramas (about 8:1 and wider with
  // Math.round, about 4:1 with floor/ceil) are refused. ADR-013's bias warning names panoramas.
  it("accepts the honest (Math.round) ladder of a panorama, 1592 × 197 (about 8:1)", () => {
    expect(checkLadder(ladder(1592, 197))).toEqual({ ok: true });
  });
  it("accepts a ladder whose heights are truncated (canvas-style floor), 1596 × 395 (about 4:1)", () => {
    expect(checkLadder(ladder(1596, 395, Math.floor))).toEqual({ ok: true });
  });

  // TESTER FINDING (Low): defence in depth. These cannot come from inspectWebp today, but
  // checkLadder is exported and takes plain numbers.
  it.each([
    ["a NaN master height", [{ width: 400, height: Number.NaN }]],
    ["a zero master height", [{ width: 400, height: 0 }]],
    ["a fractional master width", [{ width: 400.5, height: 300 }]],
  ])("refuses %s", (_, variants) => {
    expect(checkLadder(variants).ok).toBe(false);
  });

  it("refuses a negative or infinite height", () => {
    expect(checkLadder([{ width: 400, height: -300 }]).ok).toBe(false);
    expect(checkLadder([{ width: 400, height: Number.POSITIVE_INFINITY }]).ok).toBe(false);
  });
});
