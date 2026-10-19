/**
 * Tester, M6.4: the chunked hex writes of a restore are byte-exact at every chunk boundary,
 * through the binding and through the rendered SQL file text, and several uploads (one in use
 * as a dish photo, one unused, one with a single size) come back with their refs and alts.
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
import { siteContentSchema } from "../../src/content/schema";
import { exportSite } from "../../src/db/export";
import { BLOB_CHUNK_BYTES, type ImageResolver, resetStatements, seedStatements, type StoredContent, type UploadBytes } from "../../src/db/seed";
import { prepare, renderSql } from "../../src/db/sql";

const db = env.DB;
const SITE = "bistro";
const hashes = new Map<string, string>();
const fakeImages: ImageResolver = (path) => ({ id: hashes.get(path)!, mime: "image/jpeg" });
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (bytes: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));

/** Random bytes with NULs at the start, the end and either side of every chunk boundary. */
function hostile(length: number): Uint8Array {
  const b = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536) crypto.getRandomValues(b.subarray(at, at + 65_536));
  for (const at of [0, length - 1]) b[at] = 0;
  for (let k = BLOB_CHUNK_BYTES; k < length; k += BLOB_CHUNK_BYTES) {
    b[k - 1] = 0;
    b[k] = 0;
  }
  return b;
}

const LENGTHS = [1, 2, BLOB_CHUNK_BYTES - 1, BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES + 1, 2 * BLOB_CHUNK_BYTES, 2 * BLOB_CHUNK_BYTES + 1, 1_048_576];
let base: StoredContent;

beforeAll(async () => {
  for (const { ref } of imageLibrary) hashes.set(ref, await sha(new TextEncoder().encode(ref)));
  const { theme: _t, ...parsed } = siteContentSchema(SITE).parse({ settings, hours, menu, pages, gallery, images: imageLibrary, theme });
  base = parsed as StoredContent;
});

async function photosOf(content: StoredContent, uploads: UploadBytes, viaFile: boolean) {
  const statements = [...resetStatements(SITE), ...seedStatements(SITE, content, fakeImages, new Date(), "tester", uploads)];
  if (viaFile) {
    // The text the CLI writes for wrangler, one statement per line, run here statement by statement.
    const text = renderSql(statements);
    expect(text.split(";\n").length).toBe(statements.length);
    await db.batch(text.split(";\n").map((sql) => db.prepare(sql.replace(/;$/, ""))));
  } else await db.batch(prepare(db, statements));
}

describe("chunk boundaries are byte-exact", () => {
  for (const viaFile of [false, true]) {
    it(`random bytes with NULs at every boundary (${viaFile ? "rendered SQL" : "binding"})`, async () => {
      const content = structuredClone(base);
      const uploads: UploadBytes = new Map();
      for (const length of LENGTHS) {
        const bytes = hostile(length);
        const id = await sha(bytes);
        uploads.set(id, [{ width: 400, height: 300, bytes }]);
        content.images.push({ ref: id, alt: { sv: `Längd ${length}`, en: `Length ${length}` } });
      }
      await photosOf(content, uploads, viaFile);
      for (const [id, [v]] of uploads) {
        const row = await db
          .prepare("SELECT typeof(bytes) AS t, length(bytes) AS n, hex(bytes) AS h FROM image_variants WHERE site_id = ? AND image_id = ?")
          .bind(SITE, id)
          .first<{ t: string; n: number; h: string }>();
        expect(row?.t, `length ${v.bytes.length}`).toBe("blob");
        expect(row?.n, `length ${v.bytes.length}`).toBe(v.bytes.length);
        expect(row?.h.toLowerCase() === toHex(v.bytes), `length ${v.bytes.length}`).toBe(true);
      }
    }, 60_000);
  }
});

describe("several uploads round-trip", () => {
  it("in use, unused, single-size: refs, alts, sizes and byte_size come back; markup in alt is kept as text", async () => {
    const content = structuredClone(base);
    const uploads: UploadBytes = new Map();
    const make = async (sizes: Array<[number, number, number]>) => {
      const variants = sizes.map(([width, height, n]) => ({ width, height, bytes: hostile(n) }));
      const id = await sha(variants.at(-1)!.bytes);
      uploads.set(id, variants);
      return id;
    };
    const inUse = await make([
      [400, 300, 20_000],
      [800, 600, 60_000],
    ]);
    const unused = await make([
      [400, 600, 30_000],
      [800, 1200, 70_000],
      [1200, 1800, 120_000],
      [1600, 2400, 700_000],
    ]);
    const single = await make([[400, 267, 12_345]]);
    content.images.push(
      { ref: inUse, alt: { sv: "I bruk", en: "In use" } },
      { ref: unused, alt: { sv: `<img src=x onerror=alert(1)> "citat" & 'apo'`, en: "BEGIN TRANSACTION; COMMIT;" } },
      { ref: single, alt: { sv: "En storlek", en: "One size" } },
    );
    content.menu.categories[0].items[0].image = inUse;
    await photosOf(content, uploads, true);

    const after = (await exportSite(db, SITE))!;
    for (const id of [inUse, unused, single]) {
      const listed = after.content.images.find((i) => i.ref === id);
      expect(listed?.alt).toEqual(content.images.find((i) => i.ref === id)!.alt);
    }
    expect(after.content.menu.categories[0].items[0].image).toBe(inUse);
    for (const [id, variants] of uploads) {
      const rows = await db
        .prepare("SELECT width, length(bytes) AS n, hex(bytes) AS h FROM image_variants WHERE site_id = ? AND image_id = ? ORDER BY width")
        .bind(SITE, id)
        .all<{ width: number; n: number; h: string }>();
      expect(rows.results.map((r) => r.width)).toEqual(variants.map((v) => v.width));
      for (const [i, r] of rows.results.entries()) expect(r.h.toLowerCase() === toHex(variants[i].bytes)).toBe(true);
      const img = await db.prepare("SELECT width, height, byte_size FROM images WHERE site_id = ? AND id = ?").bind(SITE, id).first();
      expect(img).toEqual({ width: variants.at(-1)!.width, height: variants.at(-1)!.height, byte_size: variants.reduce((n, v) => n + v.bytes.length, 0) });
    }
  }, 60_000);

  it("another site's rows are untouched by a restore of bistro", async () => {
    const other = await sha(new TextEncoder().encode("westafrican-photo"));
    await db.prepare("INSERT OR IGNORE INTO sites (id) VALUES ('westafrican')").run();
    await db
      .prepare(
        "INSERT INTO images (site_id, id, kind, path, mime, width, height, byte_size, alt_sv, alt_en) VALUES ('westafrican', ?, 'upload', NULL, 'image/webp', 400, 300, 3, 'a', 'b')",
      )
      .bind(other)
      .run();
    await db.prepare("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('westafrican', ?, 400, 'image/webp', X'010203')").bind(other).run();
    await photosOf(structuredClone(base), new Map(), false);
    const n = await db.prepare("SELECT count(*) AS n FROM image_variants WHERE site_id = 'westafrican'").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("Your photos lists only the site's own uploads", () => {
  it("listUploads keeps sites apart and gives widths smallest first", async () => {
    const { listUploads } = await import("../../src/db/photos");
    const ctx = (siteId: string) => ({ db, siteId, userId: "owner0000001", now: new Date() });
    const bistro = await listUploads(ctx(SITE));
    const west = await listUploads(ctx("westafrican"));
    expect(west.map((u) => u.id)).toHaveLength(1);
    expect(bistro.some((u) => west[0].id === u.id)).toBe(false);
    for (const u of bistro) expect(u.widths).toEqual([...u.widths].sort((x, y) => x - y));
  });
});
