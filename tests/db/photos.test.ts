/**
 * Photo uploads in the database (plan M6.6 AC; ADR-012 §3–5, Amendment 1): one batch per
 * upload, quotas inside the guarded insert, dedup by the master's SHA-256, sites kept apart,
 * bytes stored exactly, and never an upload row without its variants.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addUpload, DATABASE_PHOTO_BYTES, photoUsage, SITE_PHOTO_BYTES, SITE_PHOTO_LIMIT, type Upload } from "../../src/db/photos";
import type { RepoContext } from "../../src/db/repository";

const db = env.DB;
const ctx = (siteId: string, userId: string | null = null): RepoContext => ({ db, siteId, userId, now: new Date("2026-10-17T12:00:00Z") });

let counter = 0;
/** Random bytes per variant; the database doesn't look inside them (the handler validates). */
function upload(widths = [400, 800], sizes = widths.map(() => 1000)): Upload {
  const variants = widths.map((width, i) => ({ width, height: Math.round(width * 0.75), bytes: crypto.getRandomValues(new Uint8Array(sizes[i])) }));
  const id = (++counter).toString(16).padStart(64, "0");
  return { id, variants, alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` } };
}

const variantHex = (site: string, id: string) =>
  db.prepare("SELECT width, hex(bytes) AS h FROM image_variants WHERE site_id = ? AND image_id = ? ORDER BY width").bind(site, id).all<{ width: number; h: string }>();
const count = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number }>())!.n;
/** A big upload row without bytes, to bring a site or the database near a limit cheaply. */
const filler = (site: string, bytes: number) =>
  db.batch([
    db.prepare("INSERT OR IGNORE INTO sites (id) VALUES (?)").bind(site),
    db
      .prepare("INSERT INTO images (site_id, id, kind, mime, width, height, byte_size, alt_sv, alt_en) VALUES (?, ?, 'upload', 'image/webp', 1600, 1200, ?, 'x', 'x')")
      .bind(site, (++counter).toString(16).padStart(64, "f"), bytes),
  ]);

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM image_variants"),
    db.prepare("DELETE FROM images"),
    db.prepare("DELETE FROM audit_log"),
    db.prepare("INSERT OR IGNORE INTO sites (id) VALUES ('bistro'), ('westafrican')"),
  ]);
});

describe("addUpload", () => {
  it("stores the image, every variant byte for byte, and one audit row, and moves the content version", async () => {
    const before = (await db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<{ v: number }>())!.v;
    const u = upload([400, 800, 1200]);
    expect(await addUpload(ctx("bistro", "owner1"), u)).toEqual({ ok: true, id: u.id });

    const row = await db.prepare("SELECT kind, path, mime, width, height, byte_size, alt_sv, alt_en FROM images WHERE site_id = 'bistro' AND id = ?").bind(u.id).first();
    expect(row).toEqual({ kind: "upload", path: null, mime: "image/webp", width: 1200, height: 900, byte_size: 3000, alt_sv: u.alt.sv, alt_en: u.alt.en });
    const stored = (await variantHex("bistro", u.id)).results;
    expect(stored.map((v) => v.width)).toEqual([400, 800, 1200]);
    stored.forEach((v, i) => expect(v.h).toBe(Uint8Array.prototype.toHex.call(u.variants[i].bytes).toUpperCase()));
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro' AND entity = 'image' AND entity_id = ? AND user_id = 'owner1'", u.id)).toBe(1);
    expect((await db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<{ v: number }>())!.v).toBeGreaterThan(before);
  });

  it("keeps NUL bytes and every byte value exactly (bytes travel as hex)", async () => {
    const u = upload([400]);
    u.variants[0].bytes = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
    await addUpload(ctx("bistro"), u);
    expect((await variantHex("bistro", u.id)).results[0].h).toBe(Uint8Array.prototype.toHex.call(u.variants[0].bytes).toUpperCase());
  });

  it("the same photo twice is one row: the second is 'duplicate' and writes nothing", async () => {
    const u = upload();
    await addUpload(ctx("bistro"), u);
    expect(await addUpload(ctx("bistro"), { ...u, alt: { sv: "Annat", en: "Other" } })).toEqual({ ok: false, error: "duplicate", id: u.id });
    expect(await count("SELECT count(*) AS n FROM image_variants WHERE site_id = 'bistro' AND image_id = ?", u.id)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image'")).toBe(1);
    expect(await db.prepare("SELECT alt_sv FROM images WHERE id = ?").bind(u.id).first("alt_sv")).toBe(u.alt.sv);
  });

  it("two identical uploads at once store it once", async () => {
    const u = upload();
    const results = await Promise.all([addUpload(ctx("bistro"), u), addUpload(ctx("bistro"), u)]);
    expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["duplicate", "ok"]);
    expect(await count("SELECT count(*) AS n FROM image_variants WHERE image_id = ?", u.id)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image'")).toBe(1);
  });

  it(`refuses photo ${SITE_PHOTO_LIMIT + 1} on one site, and writes nothing for it`, async () => {
    for (let i = 0; i < SITE_PHOTO_LIMIT; i++) expect((await addUpload(ctx("bistro"), upload([400], [10]))).ok).toBe(true);
    const last = upload([400], [10]);
    expect(await addUpload(ctx("bistro"), last)).toEqual({ ok: false, error: "quota", limit: "count" });
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", last.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM image_variants WHERE image_id = ?", last.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image'")).toBe(SITE_PHOTO_LIMIT);
    // Another site's library is its own.
    expect((await addUpload(ctx("westafrican"), upload([400], [10]))).ok).toBe(true);
  });

  it("two uploads at once for the last free slot: exactly one gets it", async () => {
    for (let i = 0; i < SITE_PHOTO_LIMIT - 1; i++) await addUpload(ctx("bistro"), upload([400], [10]));
    const results = await Promise.all([addUpload(ctx("bistro"), upload([400], [10])), addUpload(ctx("bistro"), upload([400], [10]))]);
    expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["ok", "quota"]);
    expect(await count("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'upload'")).toBe(SITE_PHOTO_LIMIT);
  });

  it("refuses an upload that would take the site past its bytes", async () => {
    await filler("bistro", SITE_PHOTO_BYTES - 1500);
    expect(await addUpload(ctx("bistro"), upload([400, 800]))).toEqual({ ok: false, error: "quota", limit: "site-bytes" });
    expect((await addUpload(ctx("bistro"), upload([400], [1500]))).ok, "exactly at the limit is allowed").toBe(true);
  });

  it("refuses any site's upload once the database-wide photo bytes are used, without telling it about other sites", async () => {
    await filler("another-restaurant", DATABASE_PHOTO_BYTES - 1000);
    expect(await addUpload(ctx("bistro"), upload([400, 800]))).toEqual({ ok: false, error: "quota", limit: "database-bytes" });
    expect((await addUpload(ctx("bistro"), upload([400], [1000]))).ok, "exactly at the limit is allowed").toBe(true);
  });

  it("a failure inside the batch leaves nothing behind (no image without variants, no audit row)", async () => {
    const u = upload([400, 800]);
    u.variants[1].bytes = new Uint8Array(1_048_577); // over image_variants' CHECK: the second variant insert fails
    await expect(addUpload(ctx("bistro"), u)).rejects.toThrow();
    expect(await count("SELECT count(*) AS n FROM images WHERE id = ?", u.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM image_variants WHERE image_id = ?", u.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity = 'image'")).toBe(0);
  });

  it("the same bytes on two sites are two rows; neither site sees the other's in its usage", async () => {
    const u = upload();
    await addUpload(ctx("bistro"), u);
    expect(await addUpload(ctx("westafrican"), u)).toEqual({ ok: true, id: u.id });
    expect(await photoUsage(ctx("bistro"))).toEqual({ count: 1, bytes: 2000 });
    expect(await photoUsage(ctx("westafrican"))).toEqual({ count: 1, bytes: 2000 });
  });

  it("invariant: no upload row ever exists without variants", async () => {
    for (let i = 0; i < 5; i++) await addUpload(ctx("bistro"), upload());
    await addUpload(ctx("bistro"), upload()).catch(() => {});
    const orphans = await count(
      "SELECT count(*) AS n FROM images i WHERE i.kind = 'upload' AND i.byte_size > 0 AND NOT EXISTS (SELECT 1 FROM image_variants v WHERE v.site_id = i.site_id AND v.image_id = i.id) AND i.alt_sv <> 'x'",
    );
    expect(orphans).toBe(0);
  });
});
