/**
 * Reading an upload form (plan M6.6; ADR-013 "Server validation"), with real WebP files made by
 * sharp, the same libwebp the browser's encoder uses: what passes, what is refused and with
 * which message, and that the owner's alt text survives a refusal.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { bodySizeProblem, MAX_UPLOAD_BODY, readUploadForm } from "../src/admin/upload";
import { t } from "../src/i18n";

const PHOTO = "public/images/bistro/kottbullar-hero.jpg";
const ladder: Record<number, Uint8Array> = {};
let jpeg: Uint8Array;

beforeAll(async () => {
  for (const width of [400, 800, 1200, 1600]) ladder[width] = new Uint8Array(await sharp(PHOTO).resize({ width }).webp({ quality: 75 }).toBuffer());
  jpeg = new Uint8Array(await sharp(PHOTO).resize({ width: 400 }).jpeg().toBuffer());
});

function form(parts: Uint8Array[], alt = { sv: "Köttbullar med gräddsås", en: "Meatballs with cream sauce" }) {
  const f = new FormData();
  f.set("alt_sv", alt.sv);
  f.set("alt_en", alt.en);
  for (const p of parts) f.append("variant", new File([p as Uint8Array<ArrayBuffer>], "v.webp", { type: "image/webp" }));
  return f;
}

describe("readUploadForm", () => {
  it("accepts the ladder, names the image by the master's SHA-256 and keeps the sizes", async () => {
    const read = await readUploadForm(form([ladder[400], ladder[800], ladder[1200], ladder[1600]]), "sv");
    expect(read.errors).toEqual({});
    expect(read.upload!.variants.map((v) => v.width)).toEqual([400, 800, 1200, 1600]);
    expect(read.upload!.id).toBe(createHash("sha256").update(ladder[1600]).digest("hex"));
    expect(read.upload!.alt).toEqual({ sv: "Köttbullar med gräddsås", en: "Meatballs with cream sauce" });
  });

  it("flattens line breaks and trims the alt text to one line", async () => {
    const read = await readUploadForm(form([ladder[400]], { sv: "  Köttbullar\nmed sås ", en: "Meatballs\twith sauce" }), "sv");
    expect(read.upload!.alt).toEqual({ sv: "Köttbullar med sås", en: "Meatballs with sauce" });
  });

  it("no photo parts (no JavaScript, or a crafted form) says why, and keeps the typed alt", async () => {
    const read = await readUploadForm(form([], { sv: "Min text", en: "My text" }), "en");
    expect(read.upload).toBeNull();
    expect(read.errors.photo).toBe(t("en", "admin.photos.needsScript"));
    expect(read.values).toEqual({ alt_sv: "Min text", alt_en: "My text" });
  });

  it("refuses a JPEG, a ladder with a gap, and a size out of order", async () => {
    for (const parts of [[jpeg], [ladder[400], ladder[1200]], [ladder[800], ladder[400]]]) {
      const read = await readUploadForm(form(parts), "sv");
      expect(read.upload).toBeNull();
      expect(read.errors.photo).toBe(t("sv", "admin.photos.notPhoto"));
    }
  });

  it("refuses more than four parts", async () => {
    const read = await readUploadForm(form([ladder[400], ladder[800], ladder[1200], ladder[1600], ladder[1600]]), "sv");
    expect(read.errors.photo).toBe(t("sv", "admin.photos.notPhoto"));
  });

  it("refuses a part over 1 MiB as too large", async () => {
    const big = new Uint8Array(1_048_577);
    big.set(ladder[400]);
    const read = await readUploadForm(form([big]), "sv");
    expect(read.errors.photo).toBe(t("sv", "admin.photos.tooLarge"));
  });

  it("an empty or over-long alt is an error on that field, with the photo itself fine", async () => {
    const read = await readUploadForm(form([ladder[400]], { sv: "   ", en: "x".repeat(301) }), "sv");
    expect(read.upload).toBeNull();
    expect(read.errors.alt_sv).toBe(t("sv", "admin.form.required"));
    expect(read.errors.alt_en).toContain("300");
    expect(read.errors.photo).toBeUndefined();
  });

  it("HEIC bytes get the 'can't be opened in this browser' message", async () => {
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic")]);
    const read = await readUploadForm(form([heic]), "sv");
    expect(read.errors.photo).toBe(t("sv", "admin.photos.cantOpen"));
  });
});

describe("bodySizeProblem", () => {
  const post = (length: string | null) => new Request("https://x/admin/photos/new/", { method: "POST", headers: length === null ? {} : { "content-length": length } });
  it("allows a body up to the cap plus the form's overhead", () => {
    expect(bodySizeProblem(post(String(MAX_UPLOAD_BODY)))).toBeNull();
  });
  it("refuses a larger body with 413 and a missing or odd length with 411", () => {
    expect(bodySizeProblem(post(String(MAX_UPLOAD_BODY + 1)))).toBe(413);
    expect(bodySizeProblem(post(null))).toBe(411);
    expect(bodySizeProblem(post("12abc"))).toBe(411);
  });
});
