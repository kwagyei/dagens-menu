/**
 * Owner photo uploads (plan M6.6; ADR-012 §3–5, Amendment 1; ADR-014 §1).
 *
 * One upload is one db.batch(): the `images` row, its WebP variants and the audit row commit
 * together or not at all, so a half-stored upload can't exist and nothing needs cleaning up.
 * The quotas are part of the guarded insert itself, so two owners uploading at once can't both
 * squeeze past a limit. The bytes travel as hex (blob-hex.ts): bound as a byte array they cost
 * more CPU than the free plan's 10 ms.
 */
import { bytesParam } from "./blob-hex";
import { isoSeconds, type RepoContext } from "./repository";
import { prepare, stmt } from "./sql";

/** Per site (ADR-012 §4, measured in M6.1). */
export const SITE_PHOTO_LIMIT = 60;
export const SITE_PHOTO_BYTES = 40_000_000;
/** Across every site in the database, leaving ≥150 MB of the 500 MB for everything else. */
export const DATABASE_PHOTO_BYTES = 350_000_000;
/** All variants of one upload together (ADR-012 Amendment 1 §4); the hex of one fits D1's 2 MB string limit. */
export const UPLOAD_BYTES = 1_000_000;

export interface UploadVariant {
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface Upload {
  /** SHA-256 of the master (widest) variant, hex: the image's id (ADR-012 §3). */
  id: string;
  /** Smallest first; the last is the master. Checked by the caller (upload-validate.ts). */
  variants: UploadVariant[];
  alt: { sv: string; en: string };
}

export type UploadResult =
  | { ok: true; id: string }
  /** The same photo is already in this site's library. */
  | { ok: false; error: "duplicate"; id: string }
  | { ok: false; error: "quota"; limit: "count" | "site-bytes" | "database-bytes" };

const AUDIT_COLUMNS = "site_id, user_id, at, entity, entity_id, action, summary";

/** Store an upload, or say why not. The caller has validated every variant and the alt. */
export async function addUpload(ctx: RepoContext, upload: Upload): Promise<UploadResult> {
  const master = upload.variants[upload.variants.length - 1];
  const total = upload.variants.reduce((n, v) => n + v.bytes.length, 0);
  const site = ctx.siteId;
  const uploads = "SELECT %s FROM images WHERE kind = 'upload'";

  const insert = stmt(
    `INSERT INTO images (site_id, id, kind, path, mime, width, height, byte_size, alt_sv, alt_en, created_at)
     SELECT ?, ?, 'upload', NULL, 'image/webp', ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM images WHERE site_id = ? AND id = ?)
       AND (${uploads.replace("%s", "count(*)")} AND site_id = ?) < ?
       AND (${uploads.replace("%s", "coalesce(sum(byte_size), 0)")} AND site_id = ?) + ? <= ?
       AND (${uploads.replace("%s", "coalesce(sum(byte_size), 0)")}) + ? <= ?`,
    site,
    upload.id,
    master.width,
    master.height,
    total,
    upload.alt.sv,
    upload.alt.en,
    isoSeconds(ctx.now),
    site,
    upload.id,
    site,
    SITE_PHOTO_LIMIT,
    site,
    total,
    SITE_PHOTO_BYTES,
    total,
    DATABASE_PHOTO_BYTES,
  );
  // Straight after the guarded insert, so changes() is the insert's (proven on production D1, M2).
  const audit = stmt(
    `INSERT INTO audit_log (${AUDIT_COLUMNS}) SELECT ?, ?, ?, 'image', ?, 'create', ? WHERE changes() > 0`,
    site,
    ctx.userId,
    isoSeconds(ctx.now),
    upload.id,
    `uploaded a photo (${master.width} × ${master.height}): ${upload.alt.en}`,
  );
  // Each variant only if its image row is there and it isn't stored yet: a refused or
  // duplicate upload writes no bytes, without relying on changes() across statements.
  const variants = upload.variants.map((v) =>
    stmt(
      `INSERT INTO image_variants (site_id, image_id, width, mime, bytes)
       SELECT ?, ?, ?, 'image/webp', unhex(?)
       WHERE EXISTS (SELECT 1 FROM images WHERE site_id = ? AND id = ? AND kind = 'upload')
         AND NOT EXISTS (SELECT 1 FROM image_variants WHERE site_id = ? AND image_id = ? AND width = ?)`,
      site,
      upload.id,
      v.width,
      bytesParam(v.bytes),
      site,
      upload.id,
      site,
      upload.id,
      v.width,
    ),
  );

  const [inserted] = await ctx.db.batch(prepare(ctx.db, [insert, audit, ...variants]));
  if (inserted.meta.changes > 0) return { ok: true, id: upload.id };

  // Nothing was written: say why, from a read (the batch is already over).
  const [existing, site_] = await ctx.db.batch([
    ctx.db.prepare("SELECT 1 AS found FROM images WHERE site_id = ? AND id = ?").bind(site, upload.id),
    ctx.db.prepare("SELECT count(*) AS n, coalesce(sum(byte_size), 0) AS bytes FROM images WHERE kind = 'upload' AND site_id = ?").bind(site),
  ]);
  if (existing.results.length > 0) return { ok: false, error: "duplicate", id: upload.id };
  const { n, bytes } = site_.results[0] as { n: number; bytes: number };
  if (n >= SITE_PHOTO_LIMIT) return { ok: false, error: "quota", limit: "count" };
  if (bytes + total > SITE_PHOTO_BYTES) return { ok: false, error: "quota", limit: "site-bytes" };
  // Neither of this site's limits: the database-wide one refused it.
  return { ok: false, error: "quota", limit: "database-bytes" };
}

/** The site's photo usage, for the upload page and the quota message. */
export async function photoUsage(ctx: RepoContext): Promise<{ count: number; bytes: number }> {
  const row = await ctx.db
    .prepare("SELECT count(*) AS count, coalesce(sum(byte_size), 0) AS bytes FROM images WHERE kind = 'upload' AND site_id = ?")
    .bind(ctx.siteId)
    .first<{ count: number; bytes: number }>();
  return row ?? { count: 0, bytes: 0 };
}

export interface UploadListing {
  id: string;
  alt: { sv: string; en: string };
  width: number;
  height: number;
  /** Widths stored, smallest first; the last is the master. */
  widths: number[];
  createdAt: string;
}

/** The site's uploads, newest first: the "Your photos" page and its download links (ADR-014 §5). */
export async function listUploads(ctx: RepoContext): Promise<UploadListing[]> {
  const rows = await ctx.db
    .prepare(
      `SELECT i.id, i.alt_sv, i.alt_en, i.width, i.height, i.created_at, group_concat(v.width) AS widths
       FROM images i JOIN image_variants v ON v.site_id = i.site_id AND v.image_id = i.id
       WHERE i.site_id = ? AND i.kind = 'upload'
       GROUP BY i.id ORDER BY i.created_at DESC, i.id`,
    )
    .bind(ctx.siteId)
    .all<{ id: string; alt_sv: string; alt_en: string; width: number; height: number; created_at: string; widths: string }>();
  return rows.results.map((r) => ({
    id: r.id,
    alt: { sv: r.alt_sv, en: r.alt_en },
    width: r.width,
    height: r.height,
    widths: r.widths.split(",").map(Number).sort((a, b) => a - b),
    createdAt: r.created_at,
  }));
}
