/**
 * The browser side of a photo upload (plan M6.7; ADR-013 "Browser pipeline").
 *
 * The original never leaves the phone. On submit, this script decodes the chosen photo with the
 * browser's own decoder (which turns it upright from its EXIF orientation), scales it down in
 * halving steps, encodes 1–4 WebP sizes with libwebp (WASM; no metadata is written, so the GPS
 * location and the rest of EXIF are gone), puts them in the form's hidden `variant` input and
 * submits the ordinary form: same URL, same token, same server checks and messages as ever.
 *
 * Every message shown comes from the page (data-msg-*), so it is in the page's language. The
 * size limits are the server's own (upload-validate.ts is pure and shared, never server-only).
 */
import encode, { init } from "@jsquash/webp/encode";
import plainWasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import simdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import { simd } from "wasm-feature-detect";
import { MAX_VARIANT_BYTES } from "../server/upload-validate";
import { halvingSteps, planSizes, type SizePlan } from "./resize";

/** The whole upload's cap (ADR-012 Amendment 1 §4); the server refuses anything over it. */
const UPLOAD_BYTES = 1_000_000;
const QUALITIES = [75, 60];

const form = document.querySelector<HTMLFormElement>("form#photo-upload");
const picker = document.querySelector<HTMLInputElement>("#photo");
const variants = document.querySelector<HTMLInputElement>("#photo-variants");
const progress = document.querySelector<HTMLElement>("#photo-progress");
const submit = form?.querySelector<HTMLButtonElement>("button[type=submit]");

class Refused extends Error {}

const message = (name: string, values: Record<string, string | number> = {}) => {
  let text = form?.dataset[`msg${name[0].toUpperCase()}${name.slice(1)}`] ?? name;
  for (const [key, value] of Object.entries(values)) text = text.replace(`{${key}}`, String(value));
  return text;
};
const say = (text: string) => {
  if (progress) progress.textContent = text;
};

let encoder: Promise<unknown> | null = null;
/** Load the encoder once: the SIMD build where the browser has it, from our own origin. A failed load can be retried. */
function loadEncoder() {
  encoder ??= (async () => {
    const url = (await simd()) ? simdWasmUrl : plainWasmUrl;
    return init(await WebAssembly.compileStreaming(fetch(url)));
  })().catch((error) => {
    encoder = null; // F7: one failed fetch must not break every later try
    throw error;
  });
  return encoder;
}

/** Decode with the browser (EXIF orientation applied), or null if it can't open the file. */
async function decode(file: File): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A 2D canvas, or a refusal if the browser won't make one this big (iOS limits canvas area). */
function canvas(width: number, height: number, read = false) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: read });
  if (!ctx) throw new Refused(message("tooManyPixels"));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { c, ctx };
}

/** Free a canvas's memory now rather than whenever the collector gets to it. */
const release = (c: HTMLCanvasElement) => {
  c.width = 0;
  c.height = 0;
};

/** Draw `source` at `width` × `height`, halving first if it is much larger (never over the canvas limit). */
function scaled(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, read = false) {
  let current: CanvasImageSource = source;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  for (const step of halvingSteps(currentWidth, width, currentHeight)) {
    const stepHeight = Math.max(1, Math.round((currentHeight * step) / currentWidth));
    const next = canvas(step, stepHeight);
    next.ctx.drawImage(current, 0, 0, step, stepHeight);
    // Only the steps made here are let go, never the caller's source (it may be the master).
    if (current !== source) release(current as HTMLCanvasElement);
    current = next.c;
    currentWidth = step;
    currentHeight = stepHeight;
  }
  const out = canvas(width, height, read);
  out.ctx.drawImage(current, 0, 0, width, height);
  if (current !== source) release(current as HTMLCanvasElement);
  return out;
}

/** The finished WebP files for `plan`, at the first quality that fits every limit. */
async function encodeSizes(img: HTMLImageElement, plan: Extract<SizePlan, { ok: true }>): Promise<File[]> {
  // Each size's pixels once (F5); the decoded original is let go as soon as the master is drawn (F4).
  const master = scaled(img, img.naturalWidth, img.naturalHeight, plan.master.width, plan.master.height, true);
  img.src = "";
  const pixels = plan.sizes.map((size) => {
    if (size.width === plan.master.width) return master.ctx.getImageData(0, 0, size.width, size.height);
    const smaller = scaled(master.c, plan.master.width, plan.master.height, size.width, size.height, true);
    const data = smaller.ctx.getImageData(0, 0, size.width, size.height);
    release(smaller.c);
    return data;
  });
  release(master.c);

  for (const quality of QUALITIES) {
    const files: File[] = [];
    let total = 0;
    for (const [index, data] of pixels.entries()) {
      say(message("preparing", { n: index + 1, total: pixels.length }));
      // Let the progress line paint before the encoder takes the main thread.
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      const bytes = await encode(data, { quality, method: 4 });
      total += bytes.byteLength;
      if (bytes.byteLength > MAX_VARIANT_BYTES || total > UPLOAD_BYTES) break; // F5: no point finishing this quality
      files.push(new File([bytes], `${data.width}.webp`, { type: "image/webp" }));
    }
    if (files.length === pixels.length) return files;
  }
  throw new Refused(message("tooLarge"));
}

const REFUSAL: Record<Exclude<SizePlan, { ok: true }>["reason"], string> = {
  "file-too-large": "fileTooLarge",
  "too-many-pixels": "tooManyPixels",
  "too-narrow": "tooNarrow",
  "no-size": "cantOpen",
};

if (form && picker && variants && progress && submit) {
  let sending = false;
  const ready = () => {
    sending = false;
    picker.disabled = false;
    submit.disabled = false;
  };
  // F6: on Back, WebKit restores the picker and the hidden sizes (from its cache or its form
  // restore), and the restored file can't be read again. An upload page always starts empty.
  const reset = () => {
    picker.value = "";
    variants.value = "";
    say("");
    ready();
  };
  reset();
  window.addEventListener("pageshow", reset);

  form.addEventListener("submit", async (event) => {
    if (sending) return;
    event.preventDefault();
    const file = picker.files?.[0];
    if (!file) return say(message("choosePhoto")); // F3: not the "needs JavaScript" text
    // Alt text first, so a missing one is caught before any encoding work.
    for (const name of ["alt_sv", "alt_en"]) {
      const alt = form.querySelector<HTMLInputElement>(`#${name}`);
      if (alt && !alt.value.trim()) {
        alt.setCustomValidity(message("altRequired"));
        alt.reportValidity();
        alt.addEventListener("input", () => alt.setCustomValidity(""), { once: true });
        return;
      }
    }
    // F1: the photo can't change under the encoder.
    picker.disabled = true;
    submit.disabled = true;
    try {
      say(message("opening"));
      const [img] = await Promise.all([decode(file), loadEncoder()]);
      if (!img) throw new Refused(message("cantOpen"));
      const plan = planSizes(file.size, img.naturalWidth, img.naturalHeight);
      if (!plan.ok) throw new Refused(message(REFUSAL[plan.reason]));
      const files = await encodeSizes(img, plan);
      const transfer = new DataTransfer();
      for (const f of files) transfer.items.add(f);
      variants.files = transfer.files;
      say(message("sending"));
      sending = true;
      // The picker has no name, so being disabled changes nothing that is sent.
      form.requestSubmit();
    } catch (error) {
      if (error instanceof Refused) say(error.message);
      else {
        console.error(error);
        say(message("failed"));
      }
      ready();
    }
  });
}
