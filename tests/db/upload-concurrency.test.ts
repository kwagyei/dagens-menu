/**
 * Tester, M6.6 (2026-10-17): addUpload under concurrency and on refusal: refused or duplicate
 * uploads write no bytes, no audit row and don't move content_version; sites stay apart; the
 * audit row is the right one; "no upload row without variants" over many concurrent uploads.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { addUpload, SITE_PHOTO_BYTES, SITE_PHOTO_LIMIT, type Upload } from "../../src/db/photos";
import type { RepoContext } from "../../src/db/repository";

const db = env.DB;
const ctx = (siteId: string, userId: string | null = null): RepoContext => ({ db, siteId, userId, now: new Date("2026-10-17T12:00:00Z") });

let counter = 0;
/** getRandomValues takes at most 64 KiB at a time. */
function random(size: number) {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(size, at + 65_536)));
  return out;
}
function upload(widths = [400, 800], sizes = widths.map(() => 500)): Upload {
  const variants = widths.map((width, i) => ({ width, height: Math.round(width * 0.75), bytes: random(sizes[i]) }));
  const id = (++counter).toString(16).padStart(64, "a");
  return { id, variants, alt: { sv: `Foto ${counter}`, en: `Photo ${counter}` } };
}
const n = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<{ n: number }>())!.n;
const version = async (site: string) => (await db.prepare("SELECT content_version AS v FROM sites WHERE id = ?").bind(site).first<{ v: number }>())!.v;
const filler = (site: string, bytes: number) =>
  db
    .prepare("INSERT INTO images (site_id, id, kind, mime, width, height, byte_size, alt_sv, alt_en) VALUES (?, ?, 'upload', 'image/webp', 1600, 1200, ?, 'x', 'x')")
    .bind(site, (++counter).toString(16).padStart(64, "e"), bytes)
    .run();

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM image_variants"),
    db.prepare("DELETE FROM images"),
    db.prepare("DELETE FROM audit_log"),
    db.prepare("INSERT OR IGNORE INTO sites (id) VALUES ('bistro'), ('westafrican')"),
  ]);
});

describe("refusals write nothing", () => {
  it("a quota refusal writes no image, no bytes, no audit row and leaves content_version", async () => {
    await filler("bistro", SITE_PHOTO_BYTES - 100);
    const before = await version("bistro");
    const u = upload();
    expect(await addUpload(ctx("bistro", "owner1"), u)).toMatchObject({ ok: false, error: "quota", limit: "site-bytes" });
    expect(await n("SELECT count(*) AS n FROM images WHERE id = ?", u.id)).toBe(0);
    expect(await n("SELECT count(*) AS n FROM image_variants")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM audit_log")).toBe(0);
    expect(await version("bistro")).toBe(before);
  });

  it("a duplicate leaves content_version and writes no bytes", async () => {
    const u = upload();
    await addUpload(ctx("bistro"), u);
    const before = await version("bistro");
    expect((await addUpload(ctx("bistro"), u)).ok).toBe(false);
    expect(await version("bistro")).toBe(before);
    expect(await n("SELECT count(*) AS n FROM image_variants")).toBe(2);
  });

  it("a duplicate on a full site says 'duplicate', not 'quota'", async () => {
    const u = upload([400], [10]);
    await addUpload(ctx("bistro"), u);
    for (let i = 1; i < SITE_PHOTO_LIMIT; i++) await addUpload(ctx("bistro"), upload([400], [10]));
    expect(await addUpload(ctx("bistro"), u)).toEqual({ ok: false, error: "duplicate", id: u.id });
  });
});

describe("the audit row", () => {
  it("is one 'create' row on this site, by this owner, naming the image and its size", async () => {
    const u = upload([400, 800, 1200]);
    await addUpload(ctx("westafrican", "owner9"), u);
    const rows = (await db.prepare("SELECT site_id, user_id, entity, entity_id, action, summary FROM audit_log").all()).results;
    expect(rows).toEqual([
      { site_id: "westafrican", user_id: "owner9", entity: "image", entity_id: u.id, action: "create", summary: `uploaded a photo (1200 × 900): ${u.alt.en}` },
    ]);
  });
});

describe("sites apart", () => {
  it("the same bytes on two sites: two image rows, two sets of variants, two audit rows", async () => {
    const u = upload();
    expect((await addUpload(ctx("bistro"), u)).ok).toBe(true);
    expect((await addUpload(ctx("westafrican"), u)).ok).toBe(true);
    expect(await n("SELECT count(*) AS n FROM images WHERE id = ?", u.id)).toBe(2);
    expect(await n("SELECT count(*) AS n FROM image_variants WHERE image_id = ? AND site_id = 'westafrican'", u.id)).toBe(2);
    expect(await n("SELECT count(*) AS n FROM image_variants WHERE image_id = ? AND site_id = 'bistro'", u.id)).toBe(2);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE entity_id = ?", u.id)).toBe(2);
  });

  it("one site at its count limit doesn't stop the other, even concurrently", async () => {
    for (let i = 0; i < SITE_PHOTO_LIMIT; i++) await filler("bistro", 10);
    const results = await Promise.all([addUpload(ctx("bistro"), upload()), addUpload(ctx("westafrican"), upload())]);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
  });
});

describe("concurrency", () => {
  it("eight uploads at once for three free slots: exactly three stored", async () => {
    for (let i = 0; i < SITE_PHOTO_LIMIT - 3; i++) await filler("bistro", 10);
    const results = await Promise.all(Array.from({ length: 8 }, () => addUpload(ctx("bistro"), upload([400], [10]))));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.error === "quota")).toHaveLength(5);
    expect(await n("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'upload'")).toBe(SITE_PHOTO_LIMIT);
    expect(await n("SELECT count(*) AS n FROM audit_log")).toBe(3);
  });

  it("two uploads at once that would each fit the site's bytes but not both: one stored", async () => {
    await filler("bistro", SITE_PHOTO_BYTES - 1500);
    const results = await Promise.all([addUpload(ctx("bistro"), upload([400], [1000])), addUpload(ctx("bistro"), upload([400], [1000]))]);
    expect(results.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["ok", "quota"]);
  });

  it("invariant over 20 concurrent uploads (some duplicates): every upload row has all its variants", async () => {
    const shared = upload([400, 800, 1200]);
    const jobs = Array.from({ length: 20 }, (_, i) => addUpload(ctx(i % 2 ? "bistro" : "westafrican"), i % 4 === 0 ? shared : upload([400, 800, 1200])));
    await Promise.all(jobs);
    const broken = await n(
      `SELECT count(*) AS n FROM images i WHERE i.kind = 'upload'
         AND (SELECT count(*) FROM image_variants v WHERE v.site_id = i.site_id AND v.image_id = i.id) <> 3`,
    );
    expect(broken).toBe(0);
    expect(await n("SELECT count(*) AS n FROM images WHERE id = ?", shared.id)).toBe(1); // only westafrican got it (i % 4 === 0 is even)
    const bytes = await n("SELECT count(*) AS n FROM images i WHERE byte_size <> (SELECT sum(length(bytes)) FROM image_variants v WHERE v.site_id = i.site_id AND v.image_id = i.id)");
    expect(bytes).toBe(0);
  });
});

describe("the size cap reaches the database", () => {
  it("one variant of exactly UPLOAD_BYTES (1,000,000) is stored byte for byte as hex", async () => {
    const u = upload([1600], [1_000_000]);
    expect(await addUpload(ctx("bistro"), u)).toEqual({ ok: true, id: u.id });
    const row = await db.prepare("SELECT length(bytes) AS n, substr(hex(bytes), 1, 64) AS head FROM image_variants WHERE image_id = ?").bind(u.id).first<{ n: number; head: string }>();
    expect(row!.n).toBe(1_000_000);
    expect(row!.head).toBe(Uint8Array.prototype.toHex.call(u.variants[0].bytes.subarray(0, 32)).toUpperCase());
  });
});
