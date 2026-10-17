/**
 * Reading an owner's photo upload (plan M6.6; ADR-013 "Server validation", ADR-012 Amendment 1).
 *
 * The browser shrinks and encodes the photo (M6.7) and posts 1–4 WebP sizes as `variant` parts
 * with the Swedish and English alt text. The server never decodes pixels: it checks the body
 * size before parsing, each part's WebP headers, the size ladder, the upload's total size, and
 * the alt text, then names the image by the SHA-256 of its largest size.
 */
import { cleanText, visibleLength, TEXT_LIMITS } from "../content/schema";
import { UPLOAD_BYTES, type Upload, type UploadVariant } from "../db/photos";
import { t } from "../i18n";
import { checkLadder, inspectWebp, LADDER_STEPS, MAX_VARIANT_BYTES } from "../server/upload-validate";
import { type FieldErrors, inputMaxLength } from "./forms";

type Locale = "sv" | "en";

/** The largest body read at all: every variant at the cap, plus the form's text fields and multipart framing. */
export const MAX_UPLOAD_BODY = UPLOAD_BYTES + 64 * 1024;

/** Refuse an oversized or unsized body before `formData()` spends CPU on it. */
export function bodySizeProblem(request: Request): 411 | 413 | null {
  const length = request.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length)) return 411;
  return Number(length) > MAX_UPLOAD_BODY ? 413 : null;
}

export interface UploadFormValues {
  alt_sv: string;
  alt_en: string;
}

export interface ReadUpload {
  values: UploadFormValues;
  /** Per field: alt_sv, alt_en, and `photo` for anything wrong with the photo itself. */
  errors: FieldErrors;
  upload: Upload | null;
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** One line, as the image library stores alt text (schema: localizedLine). */
function altError(locale: Locale, value: string): string | undefined {
  // Refuse an absurd length before cleaning or counting graphemes, which costs CPU per
  // character: a 1 MB value would outlast the Worker's 10 ms (M6.6 tester F2, F3).
  if (value.length > inputMaxLength(TEXT_LIMITS.short)) return t(locale, "admin.form.tooLong").replace("{max}", String(TEXT_LIMITS.short));
  const clean = cleanText(value).replace(/\s+/g, " ");
  if (!/[^\s\p{Cf}]/u.test(clean)) return t(locale, "admin.form.required");
  if (visibleLength(clean) > TEXT_LIMITS.short) return t(locale, "admin.form.tooLong").replace("{max}", String(TEXT_LIMITS.short));
  return undefined;
}

/** The 32-byte digest as hex; a plain loop, so it runs in Node tests too (toHex is workerd-only there). */
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");

/** Alt text as one line, the way the library stores it. */
const oneLine = (v: string) => cleanText(v).replace(/\s+/g, " ").trim();

/**
 * The two alt fields of a form (the upload form and the photo's own page, M6.10): the values
 * as typed, an error per field, and the cleaned alt when both are fine.
 */
export function readAltForm(form: FormData, locale: Locale): { values: UploadFormValues; errors: FieldErrors; alt: { sv: string; en: string } | null } {
  const values: UploadFormValues = { alt_sv: text(form, "alt_sv"), alt_en: text(form, "alt_en") };
  const errors: FieldErrors = {};
  for (const name of ["alt_sv", "alt_en"] as const) {
    const error = altError(locale, values[name]);
    if (error) errors[name] = error;
  }
  return { values, errors, alt: errors.alt_sv || errors.alt_en ? null : { sv: oneLine(values.alt_sv), en: oneLine(values.alt_en) } };
}

export async function readUploadForm(form: FormData, locale: Locale): Promise<ReadUpload> {
  const { values, errors } = readAltForm(form, locale);

  const parts = form.getAll("variant").filter((p): p is File => typeof p !== "string" && p.size > 0);
  if (parts.length === 0) {
    // Without JavaScript the picker stays disabled, so this is a crafted or old form (ADR-013).
    errors.photo = t(locale, "admin.photos.needsScript");
    return { values, errors, upload: null };
  }
  if (parts.length > LADDER_STEPS.length + 1) {
    errors.photo = t(locale, "admin.photos.notPhoto");
    return { values, errors, upload: null };
  }

  const variants: UploadVariant[] = [];
  let total = 0;
  for (const part of parts) {
    if (part.size > MAX_VARIANT_BYTES) {
      errors.photo = t(locale, "admin.photos.tooLarge");
      return { values, errors, upload: null };
    }
    const bytes = new Uint8Array(await part.arrayBuffer());
    const check = inspectWebp(bytes);
    if (!check.ok) {
      errors.photo = t(locale, check.reason === "not-webp" && check.format === "heic" ? "admin.photos.cantOpen" : "admin.photos.notPhoto");
      return { values, errors, upload: null };
    }
    total += bytes.length;
    variants.push({ width: check.width, height: check.height, bytes });
  }
  if (!checkLadder(variants).ok) {
    errors.photo = t(locale, "admin.photos.notPhoto");
    return { values, errors, upload: null };
  }
  if (total > UPLOAD_BYTES) {
    errors.photo = t(locale, "admin.photos.tooLarge");
    return { values, errors, upload: null };
  }
  if (errors.alt_sv || errors.alt_en) return { values, errors, upload: null };

  const master = variants[variants.length - 1];
  const id = hex(await crypto.subtle.digest("SHA-256", master.bytes as Uint8Array<ArrayBuffer>));
  return { values, errors, upload: { id, variants, alt: { sv: oneLine(values.alt_sv), en: oneLine(values.alt_en) } } };
}
