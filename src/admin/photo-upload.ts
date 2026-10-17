/**
 * The browser side of a photo upload (plan M6.7; ADR-013 "Browser pipeline").
 *
 * The original never leaves the phone. On submit, this script decodes the chosen photo with the
 * browser's own decoder (which turns it upright from its EXIF orientation), scales it down in
 * halving steps, encodes 1–4 WebP sizes with libwebp (WASM; no metadata is written, so the GPS
 * location and the rest of EXIF are gone), puts them in the form's hidden `variant` input and
 * submits the ordinary form: same URL, same token, same server checks and messages as ever.
 *
 * Every message shown comes from the page (data-msg-*), so it is in the page's language.
 */
import encode, { init } from "@jsquash/webp/encode";
import plainWasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import simdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";
import { simd } from "wasm-feature-detect";
import { MAX_VARIANT_BYTES } from "../server/upload-validate";
import { halvingSteps, planSizes, type SizePlan } from "./resize";

/** The whole upload's cap (ADR-012 Amendment 1 §4); kept here so the script doesn't import server code paths. */
const UPLOAD_BYTES = 1_000_000;
const QUALITIES = [75, 60];

const form = document.querySelector<HTMLFormElement>("form#photo-upload");
const picker = document.querySelector<HTMLInputElement>("#photo");
const variants = document.querySelector<HTMLInputElement>("#photo-variants");
const progress = document.querySelector<HTMLElement>("#photo-progress");
const submit = form?.querySelector<HTMLButtonElement>("button[type=submit]");

const message = (name: string, values: Record<string, string | number> = {}) => {
  let text = form?.dataset[`msg${name[0].toUpperCase()}${name.slice(1)}`] ?? name;
  for (const [key, value] of Object.entries(values)) text = text.replace(`{${key}}`, String(value));
  return text;
};
const say = (text: string) => {
  if (progress) progress.textContent = text;
};

let encoder: Promise<unknown> | null = null;
/** Load the encoder once: the SIMD build where the browser has it, compiled from our own origin. */
function loadEncoder() {
  encoder ??= (async () => {
    const url = (await simd()) ? simdWasmUrl : plainWasmUrl;
    const module = await WebAssembly.compileStreaming(fetch(url));
    return init(module);
  })();
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

function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { c, ctx };
}

/** Draw `source` (sourceWidth × sourceHeight) at `width` × `height`, halving first if it is much larger. */
function scaled(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number) {
  let current: CanvasImageSource = source;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  for (const step of halvingSteps(currentWidth, width)) {
    const stepHeight = Math.max(1, Math.round((currentHeight * step) / currentWidth));
    const { c, ctx } = canvas(step, stepHeight);
    ctx.drawImage(current, 0, 0, step, stepHeight);
    current = c;
    currentWidth = step;
    currentHeight = stepHeight;
  }
  const { c, ctx } = canvas(width, height);
  ctx.drawImage(current, 0, 0, width, height);
  return { c, ctx };
}

/** The finished WebP files for `plan`, at the first quality that fits every limit, or a reason. */
async function encodeSizes(img: HTMLImageElement, plan: Extract<SizePlan, { ok: true }>): Promise<File[] | string> {
  const master = scaled(img, img.naturalWidth, img.naturalHeight, plan.master.width, plan.master.height);
  for (const quality of QUALITIES) {
    const files: File[] = [];
    let total = 0;
    for (const [index, size] of plan.sizes.entries()) {
      say(message("preparing", { n: index + 1, total: plan.sizes.length }));
      // Let the progress line paint before the encoder takes the main thread.
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      const { ctx } = size.width === plan.master.width ? master : scaled(master.c, plan.master.width, plan.master.height, size.width, size.height);
      const pixels = ctx.getImageData(0, 0, size.width, size.height);
      const bytes = await encode(pixels, { quality, method: 4 });
      if (bytes.byteLength > MAX_VARIANT_BYTES) break;
      total += bytes.byteLength;
      files.push(new File([bytes], `${size.width}.webp`, { type: "image/webp" }));
    }
    if (files.length === plan.sizes.length && total <= UPLOAD_BYTES) return files;
  }
  return message("tooLarge");
}

const REFUSAL: Record<Exclude<SizePlan, { ok: true }>["reason"], string> = {
  "file-too-large": "fileTooLarge",
  "too-many-pixels": "tooManyPixels",
  "too-narrow": "tooNarrow",
  "no-size": "cantOpen",
};

if (form && picker && variants && progress && submit) {
  picker.disabled = false;
  let sending = false;
  form.addEventListener("submit", async (event) => {
    if (sending) return;
    const file = picker.files?.[0];
    if (!file) return; // the server explains what's missing
    event.preventDefault();
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
    submit.disabled = true;
    try {
      say(message("opening"));
      const [img] = await Promise.all([decode(file), loadEncoder()]);
      if (!img) return say(message("cantOpen"));
      const plan = planSizes(file.size, img.naturalWidth, img.naturalHeight);
      if (!plan.ok) return say(message(REFUSAL[plan.reason]));
      const files = await encodeSizes(img, plan);
      if (typeof files === "string") return say(files);
      const transfer = new DataTransfer();
      for (const f of files) transfer.items.add(f);
      variants.files = transfer.files;
      say(message("sending"));
      sending = true;
      // The submit event comes back to this handler, which now lets it through to the server.
      form.requestSubmit();
    } catch (error) {
      console.error(error);
      say(message("failed"));
    } finally {
      if (!sending) submit.disabled = false;
    }
  });
}
