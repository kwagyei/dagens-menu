/**
 * The gallery for the admin (plan M6.10b; ADR-014 §1, §6): which library photos the gallery
 * page shows, in what order. Adding takes a photo from the library; removing takes it out of
 * the gallery and keeps the photo (it shows as "not used" in the library). Moves swap a photo
 * with its neighbour, guarded like the menu's.
 *
 * Until the contract migration (M6.11), gallery_images keeps its own NOT NULL alt columns: an
 * added row copies the photo's alt into them. The public site reads the alt from the image.
 */
import { newId } from "./ids";
import type { Direction } from "./menu";
import { swapWithNeighbour, type Placed } from "./menu";
import { commitIf, type RepoContext, type WriteResult } from "./repository";
import { stmt } from "./sql";
import { isImageId } from "./library";
import { GALLERY_LIMIT } from "../content/schema";

type Localized = { sv: string; en: string };

export { GALLERY_LIMIT } from "../content/schema";

export interface GalleryEntry {
  /** The gallery row's own 12-character id; what moves and removals name. */
  id: string;
  imageId: string;
  /** The reference content uses: a built-in photo's path, or an upload's id. */
  ref: string;
  alt: Localized | null;
  width: number | null;
  height: number | null;
}

type Row = Record<string, unknown>;

/** The gallery in order. */
export async function listGallery(ctx: RepoContext): Promise<GalleryEntry[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT g.id, g.image_id, i.kind, i.path, i.alt_sv, i.alt_en, i.width, i.height
       FROM gallery_images g JOIN images i ON i.site_id = g.site_id AND i.id = g.image_id
       WHERE g.site_id = ? ORDER BY g.position, g.id`,
    )
    .bind(ctx.siteId)
    .all<Row>();
  return results.map((r) => ({
    id: r.id as string,
    imageId: r.image_id as string,
    ref: r.kind === "static" ? (r.path as string) : (r.image_id as string),
    alt: r.alt_sv === null || r.alt_en === null ? null : { sv: r.alt_sv as string, en: r.alt_en as string },
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
  }));
}

export type AddResult = WriteResult | { ok: false; error: "already" | "full" | "no-alt" };

/**
 * Add a library photo at the end of the gallery. One guarded insert: the photo is this site's
 * and has its alt, isn't in the gallery already, and the gallery isn't full. If nothing was
 * inserted, the photo is read again to say why.
 */
export async function addToGallery(ctx: RepoContext, imageId: string): Promise<AddResult> {
  if (!isImageId(imageId)) return { ok: false, error: "not-found" };
  const site = ctx.siteId;
  const alt = await ctx.db.prepare("SELECT alt_sv FROM images WHERE site_id = ? AND id = ?").bind(site, imageId).first<string | null>("alt_sv");
  const added = await commitIf(
    ctx,
    stmt(
      `INSERT INTO gallery_images (site_id, id, image_id, alt_sv, alt_en, position)
       SELECT i.site_id, ?, i.id, i.alt_sv, i.alt_en, (SELECT coalesce(max(position) + 1, 0) FROM gallery_images WHERE site_id = i.site_id)
       FROM images i
       WHERE i.site_id = ? AND i.id = ? AND i.alt_sv IS NOT NULL AND i.alt_en IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM gallery_images WHERE site_id = i.site_id AND image_id = i.id)
         AND (SELECT count(*) FROM gallery_images WHERE site_id = i.site_id) < ?`,
      newId(),
      site,
      imageId,
      GALLERY_LIMIT,
    ),
    { entity: "gallery_image", entityId: imageId, action: "create", summary: `${(alt ?? imageId.slice(0, 12)).slice(0, 60)}: added to the gallery` },
  );
  if (added) return { ok: true };
  const [image, inGallery, count] = await ctx.db.batch<Row>([
    ctx.db.prepare("SELECT alt_sv, alt_en FROM images WHERE site_id = ? AND id = ?").bind(site, imageId),
    ctx.db.prepare("SELECT 1 AS found FROM gallery_images WHERE site_id = ? AND image_id = ?").bind(site, imageId),
    ctx.db.prepare("SELECT count(*) AS n FROM gallery_images WHERE site_id = ?").bind(site),
  ]);
  const row = image.results[0];
  if (!row) return { ok: false, error: "not-found" };
  if (inGallery.results.length > 0) return { ok: false, error: "already" };
  if (row.alt_sv === null || row.alt_en === null) return { ok: false, error: "no-alt" };
  if ((count.results[0]?.n as number) >= GALLERY_LIMIT) return { ok: false, error: "full" };
  return { ok: false, error: "conflict", current: -1 };
}

const galleryRowId = (id: string) => /^[a-z0-9]{12}$/.test(id);

/** Take a photo out of the gallery; the photo itself stays in the library. */
export async function removeFromGallery(ctx: RepoContext, id: string): Promise<WriteResult> {
  if (!galleryRowId(id)) return { ok: false, error: "not-found" };
  const alt = await ctx.db
    .prepare("SELECT i.alt_sv FROM gallery_images g JOIN images i ON i.site_id = g.site_id AND i.id = g.image_id WHERE g.site_id = ? AND g.id = ?")
    .bind(ctx.siteId, id)
    .first<string | null>("alt_sv");
  const removed = await commitIf(ctx, stmt("DELETE FROM gallery_images WHERE site_id = ? AND id = ?", ctx.siteId, id), {
    entity: "gallery_image",
    entityId: id,
    action: "delete",
    summary: `${(alt ?? id).slice(0, 60)}: removed from the gallery`,
  });
  return removed ? { ok: true } : { ok: false, error: "not-found" };
}

/** Move a gallery photo one place earlier or later. */
export async function moveGalleryImage(ctx: RepoContext, id: string, direction: Direction): Promise<WriteResult> {
  if (!galleryRowId(id)) return { ok: false, error: "not-found" };
  const read = async () =>
    (await ctx.db.prepare("SELECT id, position FROM gallery_images WHERE site_id = ? ORDER BY position, id").bind(ctx.siteId).all<Placed>()).results;
  return swapWithNeighbour(ctx, "gallery_images", read, id, direction, {
    entity: "gallery_image",
    entityId: id,
    action: "reorder",
    summary: `Gallery photo moved ${direction}`,
  });
}
