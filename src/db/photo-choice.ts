/**
 * Choosing which library photo a dish or a page slot shows (plan M6.10c; ADR-014 §4).
 *
 * - A choice is one guarded UPDATE of one column: the photo must be this site's (and so has
 *   its alt, since migration 0006), or the choice is "no photo". Another site's id, an
 *   unknown one or a malformed one changes nothing and reads as not found.
 * - The row's row_version is left alone, like the sold-out toggle: a photo choice is its own
 *   field, so it never makes a dish or texts form open in another tab stale.
 * - A choice that is already the current one writes nothing (no audit row, same version).
 */
import { isImageId, PAGE_SLOTS, type PageSlot } from "./library";
import { commitIf, isoSeconds, type RepoContext, type WriteResult } from "./repository";
import { stmt } from "./sql";

export { PAGE_SLOTS, type PageSlot };
export const isPageSlot = (value: string): value is PageSlot => (PAGE_SLOTS as readonly string[]).includes(value);

/**
 * The slots each design draws (src/pages/index.astro, about.astro). Classic (Ljus) has no
 * "see the menu" band; neither design draws a menu-page photo yet. A slot outside this list
 * can only be cleared, so a choice there is never a silent no-op (M6.10c tester M1, M2).
 */
const SHOWN: Record<"classic" | "modern", readonly PageSlot[]> = {
  classic: ["hero", "story", "kitchen"],
  modern: ["hero", "cta", "story", "kitchen"],
};
export const shownSlots = (style: "classic" | "modern"): readonly PageSlot[] => SHOWN[style];

/** "this site's photo" as a SQL condition on the bound site and image id. */
const PHOTO_OK = "EXISTS (SELECT 1 FROM images WHERE site_id = ? AND id = ?)";

/** The photo a dish shows: its image id, or null for none; undefined if there is no such dish. */
export async function dishPhoto(ctx: RepoContext, itemId: string): Promise<string | null | undefined> {
  const row = await ctx.db
    .prepare("SELECT image_id, name_sv FROM menu_items WHERE site_id = ? AND id = ?")
    .bind(ctx.siteId, itemId)
    .first<{ image_id: string | null; name_sv: string }>();
  return row ? row.image_id : undefined;
}

/** Show `imageId` on the dish, or no photo with null. */
export async function setDishPhoto(ctx: RepoContext, itemId: string, imageId: string | null): Promise<WriteResult> {
  if (imageId !== null && !isImageId(imageId)) return { ok: false, error: "not-found" };
  const dish = await ctx.db
    .prepare("SELECT image_id, name_sv FROM menu_items WHERE site_id = ? AND id = ?")
    .bind(ctx.siteId, itemId)
    .first<{ image_id: string | null; name_sv: string }>();
  if (!dish) return { ok: false, error: "not-found" };
  if (dish.image_id === imageId) return { ok: true };
  const guard = imageId === null ? "1" : PHOTO_OK;
  const guardParams = imageId === null ? [] : [ctx.siteId, imageId];
  const changed = await commitIf(
    ctx,
    stmt(
      `UPDATE menu_items SET image_id = ?, updated_at = ?, updated_by = ? WHERE site_id = ? AND id = ? AND image_id IS NOT ? AND ${guard}`,
      imageId,
      isoSeconds(ctx.now),
      ctx.userId,
      ctx.siteId,
      itemId,
      imageId,
      ...guardParams,
    ),
    { entity: "menu_item", entityId: itemId, action: "update", summary: `${dish.name_sv}: ${imageId === null ? "photo removed" : "photo changed"}` },
  );
  if (changed) return { ok: true };
  // Someone chose the same photo in between: still the outcome asked for.
  return (await dishPhoto(ctx, itemId)) === imageId ? { ok: true } : { ok: false, error: "not-found" };
}

/** The photo each page slot shows (image id or null). */
export async function pagePhotos(ctx: RepoContext): Promise<Record<PageSlot, string | null> | null> {
  const row = await ctx.db
    .prepare(`SELECT ${PAGE_SLOTS.map((s) => `${s}_image_id AS ${s}`).join(", ")} FROM page_content WHERE site_id = ?`)
    .bind(ctx.siteId)
    .first<Record<PageSlot, string | null>>();
  return row ?? null;
}

/** Show `imageId` in a page slot, or no photo with null. */
export async function setPagePhoto(ctx: RepoContext, slot: PageSlot, imageId: string | null): Promise<WriteResult> {
  if (!isPageSlot(slot)) return { ok: false, error: "not-found" };
  if (imageId !== null && !isImageId(imageId)) return { ok: false, error: "not-found" };
  const current = await pagePhotos(ctx);
  if (!current) return { ok: false, error: "not-found" };
  if (current[slot] === imageId) return { ok: true };
  const column = `${slot}_image_id`; // from the fixed list above, never from input
  const guard = imageId === null ? "1" : PHOTO_OK;
  const guardParams = imageId === null ? [] : [ctx.siteId, imageId];
  const changed = await commitIf(
    ctx,
    stmt(
      `UPDATE page_content SET ${column} = ?, updated_at = ?, updated_by = ? WHERE site_id = ? AND ${column} IS NOT ? AND ${guard}`,
      imageId,
      isoSeconds(ctx.now),
      ctx.userId,
      ctx.siteId,
      imageId,
      ...guardParams,
    ),
    { entity: "page_content", entityId: slot, action: "update", summary: `Page photo ${slot}: ${imageId === null ? "removed" : "changed"}` },
  );
  if (changed) return { ok: true };
  return (await pagePhotos(ctx))?.[slot] === imageId ? { ok: true } : { ok: false, error: "not-found" };
}
