/**
 * Export and restore with uploaded photos (plan M6.4 AC; ADR-014 §5): the export names each
 * upload's sizes and master link, the reader takes them off the content and checks them, and a
 * restore with the photos' bytes gives back the same library, alts and bytes, written in
 * statements D1 accepts from a SQL file (each under 100,000 bytes).
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import imageLibrary from "../../sites/bistro/content/images.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import { type LibraryImage, siteContentSchema, type Theme } from "../../src/content/schema";
import { exportSite, uploadWidths } from "../../src/db/export";
import { exportFile, type OperatorContent, readExportFile } from "../../src/db/export-file";
import { type ImageResolver, resetStatements, seedStatements, type StoredContent, type UploadBytes } from "../../src/db/seed";
import { prepare, renderSql } from "../../src/db/sql";

const db = env.DB;
const SITE = "bistro";
const ORIGIN = "https://dagens-menu-bistro.example";
const hashes = new Map<string, string>();
const fakeImages: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const op: OperatorContent = { theme: theme as Theme, settings: settings as unknown as OperatorContent["settings"], images: imageLibrary as LibraryImage[] };
const sha = async (bytes: Uint8Array) => Uint8Array.prototype.toHex.call(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));

let content: StoredContent;
let uploads: UploadBytes;
let uploadId: string;

beforeAll(async () => {
  for (const { ref } of imageLibrary) hashes.set(ref, await sha(new TextEncoder().encode(ref)));
  // Two sizes, the master above one SQL chunk (45,000 bytes) so it is written in pieces.
  const small = crypto.getRandomValues(new Uint8Array(30_000));
  const master = new Uint8Array(130_000);
  for (let at = 0; at < master.length; at += 65_536) crypto.getRandomValues(master.subarray(at, at + 65_536));
  uploadId = await sha(master);
  uploads = new Map([[uploadId, [{ width: 400, height: 300, bytes: small }, { width: 800, height: 600, bytes: master }]]]);
  const { theme: _t, ...parsed } = siteContentSchema(SITE).parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
  content = structuredClone(parsed) as StoredContent;
  content.images.push({ ref: uploadId, alt: { sv: "Ägarens foto av köttbullar", en: "The owner's photo of meatballs" } });
  content.menu.categories[0].items[0].image = uploadId; // in use, so the restore must bring it back
  await db.batch(prepare(db, [...resetStatements(SITE), ...seedStatements(SITE, content, fakeImages, new Date(), "test", uploads)]));
});

describe("restore with uploaded photos", () => {
  it("every statement fits D1's SQL limit, and a big variant is written in chunks", () => {
    const statements = seedStatements(SITE, content, fakeImages, new Date(), "test", uploads);
    for (const s of statements) expect(renderSql([s]).length, s.sql.slice(0, 60)).toBeLessThan(100_000);
    expect(statements.filter((s) => s.sql.startsWith("UPDATE image_variants")).length).toBe(2); // 130,000 bytes = 3 chunks
  });

  it("the upload is stored with its alt and exact bytes", async () => {
    const row = await db.prepare("SELECT kind, width, height, byte_size, alt_sv FROM images WHERE site_id = ? AND id = ?").bind(SITE, uploadId).first();
    expect(row).toEqual({ kind: "upload", width: 800, height: 600, byte_size: 160_000, alt_sv: "Ägarens foto av köttbullar" });
    const stored = await db.prepare("SELECT hex(bytes) AS h FROM image_variants WHERE site_id = ? AND image_id = ? AND width = 800").bind(SITE, uploadId).first<{ h: string }>();
    expect(await sha(Uint8Array.fromHex(stored!.h))).toBe(uploadId);
  });

  it("export → read → restore gives back the same library, alts and master bytes", async () => {
    const before = (await exportSite(db, SITE))!;
    const file = exportFile(SITE, before, new Date(), { origin: ORIGIN, widths: await uploadWidths(db, SITE) });
    const listed = file.content.images.find((i) => i.ref === uploadId) as unknown as { variants: number[]; master: string };
    expect(listed).toMatchObject({ variants: [400, 800], master: `${ORIGIN}/media/${uploadId}-800.webp` });

    const read = readExportFile(JSON.stringify(file), SITE, op);
    if (!read.ok) throw new Error(read.error);
    expect(read.uploads).toEqual([{ id: uploadId, variants: [400, 800], master: `${ORIGIN}/media/${uploadId}-800.webp` }]);
    expect(read.content.images.find((i) => i.ref === uploadId)).toEqual({ ref: uploadId, alt: content.images.at(-1)!.alt, width: 800, height: 600 });

    await db.batch(prepare(db, [...resetStatements(SITE), ...seedStatements(SITE, read.content, fakeImages, new Date(), "restore", uploads)]));
    const after = (await exportSite(db, SITE))!;
    expect(after.content).toEqual(before.content);
    const master = await db.prepare("SELECT hex(bytes) AS h FROM image_variants WHERE site_id = ? AND image_id = ? AND width = 800").bind(SITE, uploadId).first<{ h: string }>();
    expect(await sha(Uint8Array.fromHex(master!.h))).toBe(uploadId);
  });

  it("refuses a restore that doesn't bring an upload's bytes", () => {
    expect(() => seedStatements(SITE, content, fakeImages, new Date(), "x", new Map())).toThrow(/bytes weren't given/);
  });

  it("refuses an export whose master link doesn't name the photo, or that puts photo fields on a curated image", async () => {
    const file = exportFile(SITE, (await exportSite(db, SITE))!, new Date(), { origin: ORIGIN, widths: await uploadWidths(db, SITE) });
    const variant = (change: (images: Array<Record<string, unknown>>) => void) => {
      const copy = structuredClone(file) as unknown as { content: { images: Array<Record<string, unknown>> } };
      change(copy.content.images);
      return readExportFile(JSON.stringify(copy), SITE, op);
    };
    const upload = (images: Array<Record<string, unknown>>) => images.find((i) => i.ref === uploadId)!;
    expect(variant((im) => (upload(im).master = `${ORIGIN}/media/${"0".repeat(64)}-800.webp`))).toMatchObject({ ok: false, error: expect.stringContaining("ending in") });
    expect(variant((im) => (upload(im).master = `${ORIGIN}/media/${uploadId}-400.webp`))).toMatchObject({ ok: false });
    expect(variant((im) => (upload(im).master = `javascript:alert(1)//media/${uploadId}-800.webp`))).toMatchObject({ ok: false });
    expect(variant((im) => (upload(im).master = `${ORIGIN}/media/${uploadId}-800.webp?x=1`))).toMatchObject({ ok: false });
    expect(variant((im) => delete upload(im).master)).toMatchObject({ ok: false });
    expect(variant((im) => (upload(im).variants = [800, 400]))).toMatchObject({ ok: false, error: expect.stringContaining("smallest first") });
    expect(variant((im) => (im[0].master = `${ORIGIN}/media/x-800.webp`))).toMatchObject({ ok: false, error: expect.stringContaining("only an uploaded photo") });
  });
});
