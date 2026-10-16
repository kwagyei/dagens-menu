/**
 * Menu editing for the admin (ADR-011 plan M5.1–M5.3), on top of the repository's rules:
 * every query is scoped to the context's site, input is validated with the content schema,
 * and each write is one batch with its audit entry (triggers move the content version).
 */
import { formatPrice } from "../content/load";
import { localizedText, menuItemSchema, TEXT_LIMITS } from "../content/schema";
import { newId } from "./ids";
import { commit, commitIf, isoSeconds, type MenuItemEdit, type RepoContext, type WriteResult } from "./repository";
import { type Statement, stmt } from "./sql";

/** At most this many dishes are featured on the home page. */
export const MAX_FEATURED = 3;

export interface AdminItem {
  id: string;
  name: { sv: string; en: string };
  priceOre: number;
  available: boolean;
  soldOutOn: string | null;
  featured: boolean;
}

export interface AdminCategory {
  id: string;
  slug: string;
  name: { sv: string; en: string };
  rowVersion: number;
  items: AdminItem[];
}

type Row = Record<string, unknown>;

/** The whole menu as the admin shows it: categories and dishes in order. */
export async function adminMenu(ctx: RepoContext): Promise<AdminCategory[]> {
  const [categories, items] = await ctx.db.batch<Row>([
    ctx.db.prepare("SELECT id, slug, name_sv, name_en, row_version FROM menu_categories WHERE site_id = ? ORDER BY position, id").bind(ctx.siteId),
    ctx.db
      .prepare(
        `SELECT i.id, i.category_id, i.name_sv, i.name_en, i.price_ore, i.available, i.sold_out_on,
           EXISTS (SELECT 1 FROM home_highlights h WHERE h.site_id = i.site_id AND h.item_id = i.id) AS featured
         FROM menu_items i WHERE i.site_id = ? ORDER BY i.position, i.id`,
      )
      .bind(ctx.siteId),
  ]);
  return categories.results.map((c) => ({
    id: c.id as string,
    slug: c.slug as string,
    name: { sv: c.name_sv as string, en: c.name_en as string },
    rowVersion: c.row_version as number,
    items: items.results
      .filter((i) => i.category_id === c.id)
      .map((i) => ({
        id: i.id as string,
        name: { sv: i.name_sv as string, en: i.name_en as string },
        priceOre: i.price_ore as number,
        available: i.available === 1,
        soldOutOn: (i.sold_out_on as string | null) ?? null,
        featured: i.featured === 1,
      })),
  }));
}

const issuesOf = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

/** Add a dish at the end of a category. */
export async function createMenuItem(
  ctx: RepoContext,
  categoryId: string,
  edit: MenuItemEdit,
): Promise<WriteResult & { id?: string }> {
  const id = newId();
  const checked = menuItemSchema(ctx.siteId).safeParse({
    id,
    name: edit.name,
    description: edit.description,
    price: edit.priceOre,
    tags: edit.tags,
    allergens: edit.allergens,
    available: edit.available,
  });
  if (!checked.success) return { ok: false, error: "invalid", issues: issuesOf(checked.error) };
  const v = checked.data;
  const added = await commitIf(
    ctx,
    stmt(
      `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, tags,
         allergens, available, position, updated_at, updated_by)
       SELECT ?, ?, c.id, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT coalesce(max(position) + 1, 0) FROM menu_items WHERE site_id = c.site_id AND category_id = c.id), ?, ?
       FROM menu_categories c WHERE c.site_id = ? AND c.id = ?`,
      ctx.siteId,
      id,
      v.name.sv,
      v.name.en,
      v.description.sv,
      v.description.en,
      v.price,
      JSON.stringify(v.tags),
      JSON.stringify(v.allergens),
      v.available ? 1 : 0,
      isoSeconds(ctx.now),
      ctx.userId,
      ctx.siteId,
      categoryId,
    ),
    { entity: "menu_item", entityId: id, action: "create", summary: `${v.name.sv}: added at ${formatPrice(v.price)}` },
  );
  return added ? { ok: true, id } : { ok: false, error: "not-found" };
}

/**
 * Feature a dish on the home page, or stop featuring it. At most MAX_FEATURED are featured;
 * the cap is part of the guarded statement, so two owners can't both add the fourth.
 */
export async function setFeatured(ctx: RepoContext, id: string, featured: boolean): Promise<WriteResult | { ok: false; error: "too-many" }> {
  const item = await ctx.db.prepare("SELECT name_sv FROM menu_items WHERE site_id = ? AND id = ?").bind(ctx.siteId, id).first<string>("name_sv");
  if (item === null) return { ok: false, error: "not-found" };
  const already = (await ctx.db.prepare("SELECT 1 AS x FROM home_highlights WHERE site_id = ? AND item_id = ?").bind(ctx.siteId, id).first("x")) !== null;
  if (already === featured) return { ok: true };
  if (!featured) {
    await commitIf(ctx, stmt("DELETE FROM home_highlights WHERE site_id = ? AND item_id = ?", ctx.siteId, id), {
      entity: "menu_item",
      entityId: id,
      action: "update",
      summary: `${item}: no longer on the home page`,
    });
    return { ok: true };
  }
  const added = await commitIf(
    ctx,
    stmt(
      `INSERT INTO home_highlights (site_id, item_id, position)
       SELECT ?, ?, (SELECT coalesce(max(position) + 1, 0) FROM home_highlights WHERE site_id = ?)
       WHERE (SELECT count(*) FROM home_highlights WHERE site_id = ?) < ?
       ON CONFLICT (site_id, item_id) DO NOTHING`,
      ctx.siteId,
      id,
      ctx.siteId,
      ctx.siteId,
      MAX_FEATURED,
    ),
    { entity: "menu_item", entityId: id, action: "update", summary: `${item}: shown on the home page` },
  );
  return added ? { ok: true } : { ok: false, error: "too-many" };
}

export type Direction = "up" | "down";

/** The ids in `order` with `id` moved one place; null if it's already at that end or absent. */
export function moved(order: string[], id: string, direction: Direction): string[] | null {
  const index = order.indexOf(id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= order.length) return null;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Renumber positions 0..n-1 in the given order: one batch, self-healing if positions drifted. */
const renumber = (table: "menu_items" | "menu_categories", site: string, order: string[]): Statement[] =>
  order.map((id, position) => stmt(`UPDATE ${table} SET position = ? WHERE site_id = ? AND id = ?`, position, site, id));

/** Move a dish one place up or down within its category. */
export async function moveMenuItem(ctx: RepoContext, id: string, direction: Direction): Promise<WriteResult> {
  const item = await ctx.db
    .prepare("SELECT category_id, name_sv FROM menu_items WHERE site_id = ? AND id = ?")
    .bind(ctx.siteId, id)
    .first<{ category_id: string; name_sv: string }>();
  if (!item) return { ok: false, error: "not-found" };
  const { results } = await ctx.db
    .prepare("SELECT id FROM menu_items WHERE site_id = ? AND category_id = ? ORDER BY position, id")
    .bind(ctx.siteId, item.category_id)
    .all<{ id: string }>();
  const order = moved(
    results.map((r) => r.id),
    id,
    direction,
  );
  if (!order) return { ok: true }; // already first or last: nothing to do
  await commit(ctx, renumber("menu_items", ctx.siteId, order), {
    entity: "menu_item",
    entityId: id,
    action: "reorder",
    summary: `${item.name_sv}: moved ${direction}`,
  });
  return { ok: true };
}

/** Move a category one place up or down. */
export async function moveCategory(ctx: RepoContext, id: string, direction: Direction): Promise<WriteResult> {
  const { results } = await ctx.db
    .prepare("SELECT id, name_sv FROM menu_categories WHERE site_id = ? ORDER BY position, id")
    .bind(ctx.siteId)
    .all<{ id: string; name_sv: string }>();
  const category = results.find((r) => r.id === id);
  if (!category) return { ok: false, error: "not-found" };
  const order = moved(
    results.map((r) => r.id),
    id,
    direction,
  );
  if (!order) return { ok: true };
  await commit(ctx, renumber("menu_categories", ctx.siteId, order), {
    entity: "menu_category",
    entityId: id,
    action: "reorder",
    summary: `${category.name_sv}: moved ${direction}`,
  });
  return { ok: true };
}

/** A URL-safe slug: "Varmrätter" → "varmratter". */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "kategori";
}

const categoryName = localizedText(TEXT_LIMITS.name);

/** Add a category at the end of the menu. Its slug comes from the Swedish name, made unique. */
export async function createCategory(ctx: RepoContext, name: { sv: string; en: string }): Promise<WriteResult & { id?: string }> {
  const checked = categoryName.safeParse(name);
  if (!checked.success) return { ok: false, error: "invalid", issues: issuesOf(checked.error) };
  const { results } = await ctx.db.prepare("SELECT slug FROM menu_categories WHERE site_id = ?").bind(ctx.siteId).all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  const base = slugify(checked.data.sv);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  const id = newId();
  await commit(
    ctx,
    [
      stmt(
        `INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position)
         VALUES (?, ?, ?, ?, ?, (SELECT coalesce(max(position) + 1, 0) FROM menu_categories WHERE site_id = ?))`,
        ctx.siteId,
        id,
        slug,
        checked.data.sv,
        checked.data.en,
        ctx.siteId,
      ),
    ],
    { entity: "menu_category", entityId: id, action: "create", summary: `${checked.data.sv}: category added` },
  );
  return { ok: true, id };
}

/** Rename a category; a stale form is a conflict. The slug stays, so links keep working. */
export async function renameCategory(
  ctx: RepoContext,
  id: string,
  expectedRowVersion: number,
  name: { sv: string; en: string },
): Promise<WriteResult> {
  const checked = categoryName.safeParse(name);
  if (!checked.success) return { ok: false, error: "invalid", issues: issuesOf(checked.error) };
  const before = await ctx.db.prepare("SELECT name_sv FROM menu_categories WHERE site_id = ? AND id = ?").bind(ctx.siteId, id).first<string>("name_sv");
  if (before === null) return { ok: false, error: "not-found" };
  const changed = await commitIf(
    ctx,
    stmt(
      "UPDATE menu_categories SET name_sv = ?, name_en = ?, row_version = row_version + 1 WHERE site_id = ? AND id = ? AND row_version = ?",
      checked.data.sv,
      checked.data.en,
      ctx.siteId,
      id,
      expectedRowVersion,
    ),
    { entity: "menu_category", entityId: id, action: "update", summary: `${before}: renamed to ${checked.data.sv}` },
  );
  if (changed) return { ok: true };
  const current = await ctx.db.prepare("SELECT row_version FROM menu_categories WHERE site_id = ? AND id = ?").bind(ctx.siteId, id).first<number>("row_version");
  return current === null ? { ok: false, error: "not-found" } : { ok: false, error: "conflict", current };
}

/** Delete a category and every dish in it (the admin asks for confirmation first). */
export async function deleteCategory(ctx: RepoContext, id: string): Promise<WriteResult> {
  const category = await ctx.db
    .prepare("SELECT name_sv, (SELECT count(*) FROM menu_items WHERE site_id = ? AND category_id = ?) AS dishes FROM menu_categories WHERE site_id = ? AND id = ?")
    .bind(ctx.siteId, id, ctx.siteId, id)
    .first<{ name_sv: string; dishes: number }>();
  if (!category) return { ok: false, error: "not-found" };
  const deleted = await commitIf(ctx, stmt("DELETE FROM menu_categories WHERE site_id = ? AND id = ?", ctx.siteId, id), {
    entity: "menu_category",
    entityId: id,
    action: "delete",
    summary: `${category.name_sv}: deleted with ${category.dishes} dish${category.dishes === 1 ? "" : "es"}`,
  });
  return deleted ? { ok: true } : { ok: false, error: "not-found" };
}
