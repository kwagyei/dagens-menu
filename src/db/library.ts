/**
 * The photo library for the admin (plan M6.10; ADR-014 §4, §6): every image of the site, where
 * each one is used, its alt text, and deleting the uploads nothing uses.
 *
 * - Usage is derived, never stored: a dish's photo, the five page photos and the gallery. One
 *   batch reads them all, so a list and its "in use" marks come from the same moment.
 * - A delete is one guarded statement: an upload, of this site, that nothing uses. If it
 *   matches nothing, the image is read again to say why (in use, built in, or gone). A use
 *   added between the check and the delete is caught by the foreign key and also reads as
 *   "in use". The sizes go with it (ON DELETE CASCADE).
 * - Built-in photos (kind 'static') are never deleted: the site's files would still list them.
 */
import { commitIf, type RepoContext, type WriteResult } from "./repository";
import { stmt } from "./sql";

type Localized = { sv: string; en: string };

/** The five page photos, by column. */
export const PAGE_SLOTS = ["hero", "cta", "menu_hero", "story", "kitchen"] as const;
export type PageSlot = (typeof PAGE_SLOTS)[number];

export type ImageUse =
  | { kind: "dish"; id: string; name: Localized }
  | { kind: "page"; slot: PageSlot }
  | { kind: "gallery"; position: number };

export interface LibraryImage {
  id: string;
  /** "static" is a built-in photo shipped with the site; "upload" is the owner's. */
  kind: "static" | "upload";
  /** The file of a built-in photo, e.g. /images/bistro/x.jpg; null for an upload. */
  path: string | null;
  /** The reference content uses: the path of a built-in photo, the id of an upload. */
  ref: string;
  alt: Localized | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  createdAt: string;
  rowVersion: number;
  uses: ImageUse[];
}

type Row = Record<string, unknown>;

/** Every use of every image of the site, by image id. */
async function usesBySite(ctx: RepoContext): Promise<Map<string, ImageUse[]>> {
  const [dishes, pages, gallery] = await ctx.db.batch<Row>([
    ctx.db.prepare("SELECT id, name_sv, name_en, image_id FROM menu_items WHERE site_id = ? AND image_id IS NOT NULL ORDER BY name_sv, id").bind(ctx.siteId),
    ctx.db.prepare(`SELECT ${PAGE_SLOTS.map((s) => `${s}_image_id`).join(", ")} FROM page_content WHERE site_id = ?`).bind(ctx.siteId),
    ctx.db.prepare("SELECT image_id, position FROM gallery_images WHERE site_id = ? ORDER BY position, id").bind(ctx.siteId),
  ]);
  const uses = new Map<string, ImageUse[]>();
  const add = (imageId: unknown, use: ImageUse) => {
    if (typeof imageId !== "string") return;
    uses.set(imageId, [...(uses.get(imageId) ?? []), use]);
  };
  for (const d of dishes.results) add(d.image_id, { kind: "dish", id: d.id as string, name: { sv: d.name_sv as string, en: d.name_en as string } });
  const p = pages.results[0];
  if (p) for (const slot of PAGE_SLOTS) add(p[`${slot}_image_id`], { kind: "page", slot });
  // Positions from 1, as the owner counts them.
  gallery.results.forEach((g, index) => add(g.image_id, { kind: "gallery", position: index + 1 }));
  return uses;
}

const IMAGE_COLUMNS = "id, kind, path, alt_sv, alt_en, width, height, byte_size, created_at, row_version";

function toImage(r: Row, uses: Map<string, ImageUse[]>): LibraryImage {
  const id = r.id as string;
  const kind = r.kind as "static" | "upload";
  return {
    id,
    kind,
    path: (r.path as string | null) ?? null,
    ref: kind === "static" ? (r.path as string) : id,
    alt: r.alt_sv === null || r.alt_en === null ? null : { sv: r.alt_sv as string, en: r.alt_en as string },
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
    byteSize: (r.byte_size as number | null) ?? null,
    createdAt: r.created_at as string,
    rowVersion: r.row_version as number,
    uses: uses.get(id) ?? [],
  };
}

/** The whole library: the owner's uploads first, newest first, then the built-in photos. */
export async function listLibrary(ctx: RepoContext): Promise<LibraryImage[]> {
  const [rows, uses] = await Promise.all([
    ctx.db
      .prepare(`SELECT ${IMAGE_COLUMNS} FROM images WHERE site_id = ? ORDER BY kind = 'static', created_at DESC, coalesce(path, id)`)
      .bind(ctx.siteId)
      .all<Row>(),
    usesBySite(ctx),
  ]);
  return rows.results.map((r) => toImage(r, uses));
}

/** One image with its uses, or null if this site has no image by that id. */
export async function getLibraryImage(ctx: RepoContext, id: string): Promise<LibraryImage | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const [row, uses] = await Promise.all([
    ctx.db.prepare(`SELECT ${IMAGE_COLUMNS} FROM images WHERE site_id = ? AND id = ?`).bind(ctx.siteId, id).first<Row>(),
    usesBySite(ctx),
  ]);
  return row ? toImage(row, uses) : null;
}

const short = (alt: Localized | null, id: string) => (alt ? alt.sv.slice(0, 60) : id.slice(0, 12));

/** Change a photo's alt text, if nobody changed the photo since `expectedRowVersion`. */
export async function updateImageAlt(ctx: RepoContext, id: string, expectedRowVersion: number, alt: Localized): Promise<WriteResult> {
  const changed = await commitIf(
    ctx,
    stmt(
      "UPDATE images SET alt_sv = ?, alt_en = ?, row_version = row_version + 1 WHERE site_id = ? AND id = ? AND row_version = ?",
      alt.sv,
      alt.en,
      ctx.siteId,
      id,
      expectedRowVersion,
    ),
    { entity: "image", entityId: id, action: "update", summary: `${alt.sv.slice(0, 60)}: description changed` },
  );
  if (changed) return { ok: true };
  const now = await getLibraryImage(ctx, id);
  return now ? { ok: false, error: "conflict", current: now.rowVersion } : { ok: false, error: "not-found" };
}

/** "Nothing uses image i": the same three places as usesBySite. */
const UNUSED = `NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.site_id = i.site_id AND m.image_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM page_content p WHERE p.site_id = i.site_id AND i.id IN (${PAGE_SLOTS.map((s) => `p.${s}_image_id`).join(", ")}))
  AND NOT EXISTS (SELECT 1 FROM gallery_images g WHERE g.site_id = i.site_id AND g.image_id = i.id)`;

/** A use added after the check: SQLite's foreign key refuses the delete. */
const isForeignKeyError = (error: unknown) => /FOREIGN KEY constraint failed/i.test(String((error as Error)?.message ?? error));

export type DeleteResult = { ok: true } | { ok: false; error: "not-found" | "built-in" } | { ok: false; error: "in-use"; uses: ImageUse[] };

/** Delete an upload that nothing uses. */
export async function deleteImage(ctx: RepoContext, id: string): Promise<DeleteResult> {
  const before = await getLibraryImage(ctx, id);
  if (!before) return { ok: false, error: "not-found" };
  let changed = false;
  try {
    changed = await commitIf(ctx, stmt(`DELETE FROM images AS i WHERE i.site_id = ? AND i.id = ? AND i.kind = 'upload' AND ${UNUSED}`, ctx.siteId, id), {
      entity: "image",
      entityId: id,
      action: "delete",
      summary: `${short(before.alt, id)}: deleted`,
    });
  } catch (error) {
    if (!isForeignKeyError(error)) throw error;
  }
  if (changed) return { ok: true };
  const now = await getLibraryImage(ctx, id);
  if (!now) return { ok: false, error: "not-found" };
  if (now.kind === "static") return { ok: false, error: "built-in" };
  return { ok: false, error: "in-use", uses: now.uses };
}

/**
 * Delete every upload nothing uses, as one transaction, and say how many went. The count and
 * its audit entry are read in the same batch as the delete, so they describe what it removed.
 */
export async function deleteUnusedImages(ctx: RepoContext): Promise<{ deleted: number }> {
  const unused = `FROM images AS i WHERE i.site_id = ? AND i.kind = 'upload' AND ${UNUSED}`;
  const batch = async () => {
    const [count] = await ctx.db.batch<{ n: number }>([
      ctx.db.prepare(`SELECT count(*) AS n ${unused}`).bind(ctx.siteId),
      ctx.db
        .prepare(
          `INSERT INTO audit_log (site_id, user_id, at, entity, entity_id, action, summary)
           SELECT ?, ?, ?, 'image', NULL, 'delete', 'Deleted ' || n || ' unused photo(s)' FROM (SELECT count(*) AS n ${unused}) WHERE n > 0`,
        )
        .bind(ctx.siteId, ctx.userId, `${ctx.now.toISOString().slice(0, 19)}Z`, ctx.siteId),
      ctx.db.prepare(`DELETE FROM images AS i WHERE i.site_id = ? AND i.kind = 'upload' AND ${UNUSED}`).bind(ctx.siteId),
    ]);
    return { deleted: count.results[0]?.n ?? 0 };
  };
  try {
    return await batch();
  } catch (error) {
    // A use added mid-way rolled the whole batch back: try once more, without that photo.
    if (!isForeignKeyError(error)) throw error;
    return await batch();
  }
}
