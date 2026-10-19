/**
 * Tester, M6.6 (2026-10-17): attacks on readUploadForm with real sharp output and hand-made
 * WebP containers: polyglots, markup renamed .webp, animation, EXIF/XMP, wrong ladders, the
 * total cap, odd parts, and alt text that is long in code units but short in graphemes.
 */
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { readUploadForm } from "../src/admin/upload";
import { UPLOAD_BYTES } from "../src/db/photos";
import { t } from "../src/i18n";

const PHOTO = "public/images/bistro/kottbullar-hero.jpg";
const enc = new TextEncoder();
const HTML = enc.encode("<html><script>alert(document.domain)</script></html>");
const ALT = { sv: "Köttbullar med gräddsås", en: "Meatballs with cream sauce" };

const plain: Record<number, Uint8Array> = {};

beforeAll(async () => {
  for (const width of [400, 800, 1200, 1600]) plain[width] = new Uint8Array(await sharp(PHOTO).resize({ width }).webp({ quality: 60 }).toBuffer());
});

const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const chunk = (id: string, payload: Uint8Array) => {
  const pad = payload.length % 2 ? [0] : [];
  return new Uint8Array([...enc.encode(id), ...u32(payload.length), ...payload, ...pad]);
};
const riff = (...chunks: Uint8Array[]) => {
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set([...enc.encode("RIFF"), ...u32(body + 4), ...enc.encode("WEBP")]);
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
/** The VP8 chunk of a simple sharp WebP, and its size from the frame header. */
function vp8Of(simple: Uint8Array) {
  const size = simple[16] | (simple[17] << 8) | (simple[18] << 16) | (simple[19] << 24);
  const payload = simple.subarray(20, 20 + size);
  return { payload, width: (payload[6] | (payload[7] << 8)) & 0x3fff, height: (payload[8] | (payload[9] << 8)) & 0x3fff };
}
const vp8xHeader = (flags: number, w: number, h: number) => chunk("VP8X", new Uint8Array([flags, 0, 0, 0, ...u24(w - 1), ...u24(h - 1)]));
/** A valid ICC header (own size, "acsp" at 36) followed by whatever bytes, `total` long. */
function icc(total: number, tail: Uint8Array = new Uint8Array()) {
  const p = new Uint8Array(total);
  p.set([(total >>> 24) & 255, (total >> 16) & 255, (total >> 8) & 255, total & 255]);
  p.set(enc.encode("acsp"), 36);
  p.set(tail, 128);
  return p;
}
/** Same image, extended format with an ICC chunk of `iccBytes` (to reach a byte size). */
function withIcc(simple: Uint8Array, iccBytes: number, tail?: Uint8Array) {
  const v = vp8Of(simple);
  return riff(vp8xHeader(0x20, v.width, v.height), chunk("ICCP", icc(iccBytes, tail)), chunk("VP8 ", v.payload));
}

function form(parts: (Uint8Array | string)[], alt = ALT, name = "variant") {
  const f = new FormData();
  f.set("alt_sv", alt.sv);
  f.set("alt_en", alt.en);
  for (const p of parts) f.append(name, typeof p === "string" ? p : new File([p as Uint8Array<ArrayBuffer>], "v.webp", { type: "image/webp" }));
  return f;
}

async function refused(parts: Uint8Array[], key: string) {
  for (const locale of ["sv", "en"] as const) {
    const read = await readUploadForm(form(parts, { sv: "Min text", en: "My text" }), locale);
    expect(read.upload, `${locale}: should be refused`).toBeNull();
    expect(read.errors.photo).toBe(t(locale, key as never));
    expect(read.values).toEqual({ alt_sv: "Min text", alt_en: "My text" });
  }
}

describe("content attacks are refused with the right message, alt kept (sv and en)", () => {
  it("RIFF…WEBP with HTML appended after the image", async () => {
    const poly = new Uint8Array([...plain[400], ...HTML]);
    await refused([poly], "admin.photos.notPhoto");
  });
  it("RIFF size patched to cover appended HTML (an unknown trailing chunk)", async () => {
    const v = vp8Of(plain[400]);
    await refused([riff(chunk("VP8 ", v.payload), chunk("html", HTML))], "admin.photos.notPhoto");
  });
  it("HTML and SVG renamed .webp", async () => {
    await refused([HTML], "admin.photos.notPhoto");
    await refused([enc.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')], "admin.photos.notPhoto");
  });
  it("EXIF and XMP written by sharp", async () => {
    await refused([new Uint8Array(await sharp(PHOTO).resize({ width: 400 }).withExif({ IFD0: { Copyright: "GPS here" } }).webp().toBuffer())], "admin.photos.notPhoto");
    await refused([new Uint8Array(await sharp(PHOTO).resize({ width: 400 }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>').webp().toBuffer())], "admin.photos.notPhoto");
  });
  it("an animated WebP (VP8X animation flag + ANIM chunk)", async () => {
    const v = vp8Of(plain[400]);
    await refused([riff(vp8xHeader(0x02, v.width, v.height), chunk("ANIM", new Uint8Array(6)), chunk("VP8 ", v.payload))], "admin.photos.notPhoto");
  });
  it("sizes from different photos (aspect mismatch)", async () => {
    const square = new Uint8Array(await sharp(PHOTO).resize({ width: 400, height: 400 }).webp().toBuffer());
    await refused([square, plain[800]], "admin.photos.notPhoto");
  });
  it("a master wider than 1600 or taller than 2400", async () => {
    const wide = new Uint8Array(await sharp(PHOTO).resize({ width: 1601 }).webp({ quality: 30 }).toBuffer());
    await refused([plain[400], plain[800], plain[1200], wide], "admin.photos.notPhoto");
    const tall = new Uint8Array(await sharp({ create: { width: 1000, height: 2401, channels: 3, background: "#a33" } }).webp().toBuffer());
    const tallSmall = [400, 800].map(async (w) => new Uint8Array(await sharp({ create: { width: w, height: Math.round((w * 2401) / 1000), channels: 3, background: "#a33" } }).webp().toBuffer()));
    await refused([...(await Promise.all(tallSmall)), tall], "admin.photos.notPhoto");
  });
  it("a master of exactly 1600 × 2400 is accepted", async () => {
    const make = (w: number) => sharp({ create: { width: w, height: w * 1.5, channels: 3, background: "#3a3" } }).webp().toBuffer();
    const parts = await Promise.all([400, 800, 1200, 1600].map(async (w) => new Uint8Array(await make(w))));
    const read = await readUploadForm(form(parts), "sv");
    expect(read.errors).toEqual({});
    expect(read.upload!.variants.at(-1)).toMatchObject({ width: 1600, height: 2400 });
  });
  it("duplicate widths and sizes in the wrong order", async () => {
    await refused([plain[400], plain[400]], "admin.photos.notPhoto");
    await refused([plain[400], plain[800], plain[800]], "admin.photos.notPhoto");
    await refused([plain[1200], plain[800], plain[400]], "admin.photos.notPhoto");
    await refused([plain[400], plain[1200], plain[800], plain[1600]], "admin.photos.notPhoto");
  });
});

describe("the upload's total size (ADR-012 Amendment 1: 1,000,000 bytes)", () => {
  it("each part under 1 MiB but the total over 1,000,000 is 'too large'", async () => {
    const a = withIcc(plain[400], 520_000);
    const b = withIcc(plain[800], 520_000);
    expect(a.length).toBeLessThan(1_048_576);
    await refused([a, b], "admin.photos.tooLarge");
  });
  it("a total of exactly 1,000,000 bytes is accepted", async () => {
    const base = plain[400].length + 18 + 8; // VP8X chunk 18 bytes, ICCP chunk header 8
    const part = withIcc(plain[400], UPLOAD_BYTES - base);
    expect(part.length).toBe(UPLOAD_BYTES);
    const read = await readUploadForm(form([part]), "sv");
    expect(read.errors).toEqual({});
  });
});

describe("odd parts", () => {
  it("a `variant` sent as a string only is the no-JavaScript message", async () => {
    const read = await readUploadForm(form(["UklGRg==", "x"]), "en");
    expect(read.errors.photo).toBe(t("en", "admin.photos.needsScript"));
  });
  it("string `variant` parts next to a real one are ignored, not counted against the four", async () => {
    const read = await readUploadForm(form(["a", "b", "c", "d", "e", plain[400]]), "sv");
    expect(read.errors).toEqual({});
  });
  it("many empty file parts next to a real one are ignored", async () => {
    const f = form([plain[400]]);
    for (let i = 0; i < 2000; i++) f.append("variant", new File([], "e.webp"));
    const read = await readUploadForm(f, "sv");
    expect(read.errors).toEqual({});
    expect(read.upload!.variants).toHaveLength(1);
  });
  it("files under other field names are never read as variants", async () => {
    const f = form([], ALT);
    f.append("variant[]", new File([plain[400] as Uint8Array<ArrayBuffer>], "v.webp"));
    f.append("photo", new File([plain[400] as Uint8Array<ArrayBuffer>], "v.webp"));
    const read = await readUploadForm(f, "sv");
    expect(read.errors.photo).toBe(t("sv", "admin.photos.needsScript"));
  });
});

describe("alt text", () => {
  it("a 1 MB alt is refused as too long, quickly", async () => {
    const start = performance.now();
    const read = await readUploadForm(form([plain[400]], { sv: "a".repeat(1_000_000), en: "ok" }), "sv");
    const ms = performance.now() - start;
    expect(read.errors.alt_sv).toContain("300");
    expect(read.upload).toBeNull();
    // Recorded for the report (Node on a laptop, not workerd): see console output.
    console.log(`tester: 1 MB alt took ${ms.toFixed(1)} ms in readUploadForm`);
  });

  // FINDING (tester M6.6): visibleLength counts graphemes, so 300 "characters" can carry
  // hundreds of kilobytes of combining marks. Such an alt is stored (and copied into the
  // audit summary) outside every photo quota. Fixed: alt is capped in code units (600) first.
  it("an alt of 300 graphemes but ~300,000 code units is refused", async () => {
    const zalgo = ("a" + "́".repeat(999)).repeat(300);
    expect(zalgo.length).toBe(300_000);
    const read = await readUploadForm(form([plain[400]], { sv: "Text", en: zalgo }), "sv");
    expect(read.upload).toBeNull();
  });

  it("an alt of only invisible format characters (LRM, Mongolian separator) is required", async () => {
    const read = await readUploadForm(form([plain[400]], { sv: "‎‏", en: "᠎" }), "en");
    expect(read.errors.alt_sv).toBe(t("en", "admin.form.required"));
    expect(read.errors.alt_en).toBe(t("en", "admin.form.required"));
  });
});

describe("polyglot room left by design (ADR-013 note: ICC profiles accepted)", () => {
  // Documents behaviour, not a bug: everything after the 128-byte ICC header is unchecked, so
  // HTML can ride inside an accepted file. Harmless only while /media serves image/webp with
  // nosniff and a sandbox CSP (ADR-015, M6.8): that test belongs to M6.8.
  it("HTML inside an ICCP chunk after a valid ICC header is accepted", async () => {
    const read = await readUploadForm(form([withIcc(plain[400], 1024, HTML)]), "sv");
    expect(read.errors).toEqual({});
  });
});
