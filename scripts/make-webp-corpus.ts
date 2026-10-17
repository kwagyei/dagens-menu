/**
 * Regenerate the WebP corpus that tests the upload validator against sharp (M6 plan, M6.5).
 *
 *   npx tsx scripts/make-webp-corpus.ts
 *
 * Writes tests/fixtures/webp/<encoder>-<case>.webp from three independent encoders:
 *   - sharp      libvips' libwebp, the reference reader in the tests
 *   - jsquash    @jsquash/webp, the WASM build the admin will run in the browser (M6.7)
 *   - chromium   Chromium's own encoder, via canvas.toBlob("image/webp") in Playwright
 * The bytes come from the encoders, never by hand. The source pixels are deterministic, so
 * a rerun with the same encoder versions gives the same files.
 *
 * The libwebp test-data repository is not vendored: it has no licence file. The corpus test
 * reads it from a local checkout when WEBP_TEST_DATA points at one.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const out = join(import.meta.dirname, "..", "tests", "fixtures", "webp");
const require = createRequire(import.meta.url);

/** Smooth gradients with a little deterministic texture, so lossy output has real content. */
function pixels(width: number, height: number, alpha: "opaque" | "fade" | "holes" = "opaque", seed = 1): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 16) - 8;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / Math.max(1, width - 1) + rand();
      data[i + 1] = (y * 255) / Math.max(1, height - 1) + rand();
      data[i + 2] = 128 + 100 * Math.sin((x + y) / 7) + rand();
      data[i + 3] = alpha === "opaque" ? 255 : alpha === "fade" ? (x * 255) / Math.max(1, width - 1) : (x + y) % 9 === 0 ? 0 : 255;
    }
  }
  return data;
}

interface Case {
  name: string;
  width: number;
  height: number;
  alpha?: "opaque" | "fade" | "holes";
}

// Sizes: the real ladder steps, the extremes the format allows, and odd shapes.
const SHAPES: Case[] = [
  { name: "1600x1200", width: 1600, height: 1200 },
  { name: "1200x1800", width: 1200, height: 1800 },
  { name: "800x533", width: 800, height: 533 },
  { name: "400x300", width: 400, height: 300 },
  { name: "1x1", width: 1, height: 1 },
  { name: "13x1", width: 13, height: 1 },
  { name: "1x13", width: 1, height: 13 },
  { name: "31x13", width: 31, height: 13 },
  { name: "321x479-alpha-fade", width: 321, height: 479, alpha: "fade" },
  { name: "64x64-alpha-holes", width: 64, height: 64, alpha: "holes" },
];

async function sharpCorpus(write: (name: string, bytes: Uint8Array) => void) {
  const raw = (c: Case) => sharp(Buffer.from(pixels(c.width, c.height, c.alpha).buffer), { raw: { width: c.width, height: c.height, channels: 4 } });
  for (const c of SHAPES) {
    write(`sharp-${c.name}-q75`, await raw(c).webp({ quality: 75 }).toBuffer());
  }
  const mid = SHAPES[3];
  const alpha = SHAPES[8];
  write("sharp-400x300-q5", await raw(mid).webp({ quality: 5 }).toBuffer());
  write("sharp-400x300-q100-effort6", await raw(mid).webp({ quality: 100, effort: 6 }).toBuffer());
  write("sharp-400x300-effort0", await raw(mid).webp({ quality: 75, effort: 0 }).toBuffer());
  write("sharp-400x300-smart-subsample", await raw(mid).webp({ quality: 75, smartSubsample: true }).toBuffer());
  write("sharp-400x300-lossless", await raw(mid).webp({ lossless: true }).toBuffer());
  write("sharp-400x300-near-lossless", await raw(mid).webp({ nearLossless: true, quality: 60 }).toBuffer());
  write("sharp-alpha-lossless", await raw(alpha).webp({ lossless: true }).toBuffer());
  write("sharp-alpha-q75-alphaq50", await raw(alpha).webp({ quality: 75, alphaQuality: 50 }).toBuffer());
  write("sharp-16383x1-lossless", await raw({ name: "", width: 16383, height: 1 }).webp({ lossless: true }).toBuffer());
  write("sharp-400x300-icc", await raw(mid).webp({ quality: 75 }).withIccProfile("srgb").toBuffer());
  // Files the validator must refuse; sharp's metadata says why.
  write("sharp-refuse-exif", await raw(mid).webp({ quality: 75 }).withExif({ IFD0: { Copyright: "dagens-menu test" } }).toBuffer());
  write("sharp-refuse-xmp", await raw(mid).webp({ quality: 75 }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>').toBuffer());
  const frame = (shift: number) => raw({ name: "", width: 32, height: 32 }).png().toBuffer().then((png) => sharp(png).modulate({ hue: shift }).png().toBuffer());
  write(
    "sharp-refuse-animated",
    await sharp([await frame(0), await frame(120), await frame(240)], { join: { animated: true } })
      .webp({ quality: 75, loop: 0, delay: 100 })
      .toBuffer(),
  );
}

async function jsquashCorpus(write: (name: string, bytes: Uint8Array) => void) {
  const { default: encode, init } = await import("@jsquash/webp/encode.js");
  // In Node the WASM has no URL to fetch, so compile it here and hand it over.
  const wasm = join(dirname(require.resolve("@jsquash/webp/encode.js")), "codec", "enc", "webp_enc_simd.wasm");
  await init(await WebAssembly.compile(readFileSync(wasm)));
  // Another seed than sharp's: both use libwebp, and the same pixels give byte-identical files.
  const image = (c: Case) => ({ data: pixels(c.width, c.height, c.alpha, 2), width: c.width, height: c.height, colorSpace: "srgb" }) as ImageData;
  for (const c of SHAPES) {
    // The admin's settings (ADR-013): lossy, quality 75, method 4.
    write(`jsquash-${c.name}-q75`, new Uint8Array(await encode(image(c), { quality: 75, method: 4 })));
  }
  const mid = SHAPES[3];
  const alpha = SHAPES[8];
  write("jsquash-400x300-q60", new Uint8Array(await encode(image(mid), { quality: 60 })));
  write("jsquash-400x300-method0", new Uint8Array(await encode(image(mid), { quality: 75, method: 0 })));
  write("jsquash-400x300-method6-sharp-yuv", new Uint8Array(await encode(image(mid), { quality: 75, method: 6, use_sharp_yuv: 1 })));
  write("jsquash-400x300-lossless", new Uint8Array(await encode(image(mid), { lossless: 1 })));
  write("jsquash-400x300-near-lossless", new Uint8Array(await encode(image(mid), { lossless: 1, near_lossless: 60 })));
  write("jsquash-alpha-lossless-exact", new Uint8Array(await encode(image(alpha), { lossless: 1, exact: 1 })));
  write("jsquash-alpha-uncompressed", new Uint8Array(await encode(image(alpha), { quality: 75, alpha_compression: 0 })));
}

async function chromiumCorpus(write: (name: string, bytes: Uint8Array) => void) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const encodeIn = (c: Case, quality: number) =>
      page.evaluate(
        async ({ width, height, alpha, quality }) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d")!;
          const g = ctx.createLinearGradient(0, 0, width, height);
          g.addColorStop(0, alpha ? "rgba(200,40,40,0)" : "rgb(200,40,40)");
          g.addColorStop(1, "rgb(30,90,220)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = "rgb(250,220,120)";
          for (let i = 0; i < 40; i++) ctx.fillRect((i * 37) % width, (i * 53) % height, 3, 3);
          const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/webp", quality));
          if (blob.type !== "image/webp") throw new Error(`Chromium returned ${blob.type}`);
          return [...new Uint8Array(await blob.arrayBuffer())];
        },
        { width: c.width, height: c.height, alpha: c.alpha !== undefined, quality },
      );
    for (const c of SHAPES) write(`chromium-${c.name}-q75`, new Uint8Array(await encodeIn(c, 0.75)));
    write("chromium-400x300-q10", new Uint8Array(await encodeIn(SHAPES[3], 0.1)));
    write("chromium-400x300-q100", new Uint8Array(await encodeIn(SHAPES[3], 1)));
    write("chromium-alpha-q100", new Uint8Array(await encodeIn(SHAPES[8], 1)));
  } finally {
    await browser.close();
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const write = (name: string, bytes: Uint8Array) => writeFileSync(join(out, `${name}.webp`), bytes);
await sharpCorpus(write);
await jsquashCorpus(write);
await chromiumCorpus(write);
const files = readdirSync(out);
console.log(`${files.length} files in ${out}`);
