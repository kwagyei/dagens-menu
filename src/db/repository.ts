/**
 * The only code that writes restaurant content (ADR-011 §5, §8; plan M2.3).
 *
 * - Every function takes a RepoContext whose siteId comes from the Worker's own site, never
 *   from user input, and every query is scoped by it: another site's id simply isn't found.
 * - Every write is one db.batch(), which D1 runs as a transaction, holding the change, the
 *   content_version bump and the audit entry. Either all of it happens or none of it does.
 * - Input is validated with the content schema here, so no caller can store invalid content.
 */
import { formatPrice } from "../content/load";
import { restaurantDay } from "../content/hours";
import { menuItemSchema } from "../content/schema";
import { type Statement, prepare, stmt } from "./sql";
import type { D1Database } from "./types";

export interface RepoContext {
  db: D1Database;
  siteId: string;
  /** The signed-in user making the change; null for operator scripts. */
  userId: string | null;
  now: Date;
}

export interface Audit {
  entity: string;
  entityId: string | null;
  action: "create" | "update" | "delete" | "reorder";
  summary: string;
}

export type WriteResult =
  | { ok: true }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "conflict"; current: number }
  | { ok: false; error: "invalid"; issues: Array<{ path: string; message: string }> };

/** ISO-8601 UTC to the second: the one timestamp format the database stores. */
export const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

const AUDIT_COLUMNS = "site_id, user_id, at, entity, entity_id, action, summary";
const auditValues = (ctx: RepoContext, a: Audit) => [ctx.siteId, ctx.userId, isoSeconds(ctx.now), a.entity, a.entityId, a.action, a.summary];
const audit = (ctx: RepoContext, a: Audit) => stmt(`INSERT INTO audit_log (${AUDIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, ...auditValues(ctx, a));

// content_version needs no statement here: triggers on every content table bump it in the
// same transaction as the change (migrations/0001_content.sql).

/** Apply `statements` unconditionally, with the audit entry, as one transaction. */
export async function commit(ctx: RepoContext, statements: Statement[], entry: Audit): Promise<void> {
  await ctx.db.batch(prepare(ctx.db, [...statements, audit(ctx, entry)]));
}

/**
 * Apply one guarded statement (an UPDATE or DELETE whose WHERE clause carries the site, the
 * id and, for edits, the expected row_version), with its audit entry, as one transaction.
 * Returns whether the guard matched any row; if it matched none, nothing is written.
 *
 * The audit insert is conditional on SQLite's changes() for the guard, which holds when D1
 * runs the batch on one connection, as it does locally. Should that ever not hold, a write
 * that happened without its audit row is detected and the row is written separately, so
 * the audit trail stays complete either way. (The content version never depends on it.)
 */
export async function commitIf(ctx: RepoContext, guard: Statement, entry: Audit): Promise<boolean> {
  const auditIfChanged = stmt(`INSERT INTO audit_log (${AUDIT_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`, ...auditValues(ctx, entry));
  const [written, audited] = await ctx.db.batch(prepare(ctx.db, [guard, auditIfChanged]));
  // D1's meta.changes also counts rows removed by ON DELETE CASCADE, unlike changes().
  const changed = written.meta.changes > 0;
  if (changed && audited.meta.changes === 0) {
    console.warn(`audit: ${entry.entity} ${entry.entityId ?? ""} was written without its audit row; adding it separately`);
    await ctx.db.batch(prepare(ctx.db, [audit(ctx, entry)]));
  }
  return changed;
}

export interface MenuItemRecord {
  id: string;
  categoryId: string;
  name: { sv: string; en: string };
  description: { sv: string; en: string };
  priceOre: number;
  tags: string[];
  allergens: string[];
  available: boolean;
  soldOutOn: string | null;
  rowVersion: number;
}

type Row = Record<string, unknown>;
const toItem = (r: Row): MenuItemRecord => ({
  id: r.id as string,
  categoryId: r.category_id as string,
  name: { sv: r.name_sv as string, en: r.name_en as string },
  description: { sv: r.description_sv as string, en: r.description_en as string },
  priceOre: r.price_ore as number,
  tags: JSON.parse(r.tags as string),
  allergens: JSON.parse(r.allergens as string),
  available: r.available === 1,
  soldOutOn: (r.sold_out_on as string | null) ?? null,
  rowVersion: r.row_version as number,
});

export async function getMenuItem(ctx: RepoContext, id: string): Promise<MenuItemRecord | null> {
  const row = await ctx.db.prepare("SELECT * FROM menu_items WHERE site_id = ? AND id = ?").bind(ctx.siteId, id).first<Row>();
  return row ? toItem(row) : null;
}

export interface MenuItemEdit {
  name: { sv: string; en: string };
  description: { sv: string; en: string };
  priceOre: number;
  tags: string[];
  allergens: string[];
  available: boolean;
}

function describeChange(before: MenuItemRecord, after: MenuItemEdit): string {
  const changes: string[] = [];
  if (before.priceOre !== after.priceOre) changes.push(`price ${formatPrice(before.priceOre)} → ${formatPrice(after.priceOre)}`);
  if (before.name.sv !== after.name.sv || before.name.en !== after.name.en) changes.push("name");
  if (before.description.sv !== after.description.sv || before.description.en !== after.description.en) changes.push("description");
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) changes.push("tags");
  if (JSON.stringify(before.allergens) !== JSON.stringify(after.allergens)) changes.push("allergens");
  if (before.available !== after.available) changes.push(after.available ? "back on the menu" : "taken off the menu");
  return `${after.name.sv}: ${changes.length > 0 ? changes.join(", ") : "saved without changes"}`;
}

/**
 * Edit a dish. `expectedRowVersion` is the version the form was rendered from: if someone
 * saved in between, the result is a conflict and nothing is written.
 */
export async function updateMenuItem(ctx: RepoContext, id: string, expectedRowVersion: number, edit: MenuItemEdit): Promise<WriteResult> {
  const checked = menuItemSchema(ctx.siteId).safeParse({
    id,
    name: edit.name,
    description: edit.description,
    price: edit.priceOre,
    tags: edit.tags,
    allergens: edit.allergens,
    available: edit.available,
  });
  if (!checked.success) {
    return { ok: false, error: "invalid", issues: checked.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const before = await getMenuItem(ctx, id);
  if (!before) return { ok: false, error: "not-found" };
  const v = checked.data;
  const changed = await commitIf(
    ctx,
    stmt(
      `UPDATE menu_items SET name_sv = ?, name_en = ?, description_sv = ?, description_en = ?, price_ore = ?, tags = ?,
         allergens = ?, available = ?, row_version = row_version + 1, updated_at = ?, updated_by = ?
       WHERE site_id = ? AND id = ? AND row_version = ?`,
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
      id,
      expectedRowVersion,
    ),
    {
      entity: "menu_item",
      entityId: id,
      action: "update",
      // From the validated, cleaned values: what was stored, not what was typed.
      summary: describeChange(before, { name: v.name, description: v.description, priceOre: v.price, tags: v.tags, allergens: v.allergens, available: v.available }),
    },
  );
  if (changed) return { ok: true };
  const current = await getMenuItem(ctx, id);
  return current ? { ok: false, error: "conflict", current: current.rowVersion } : { ok: false, error: "not-found" };
}

/**
 * The one-tap toggle: sold out for the rest of today (the restaurant's calendar day), or
 * back on sale. It clears itself at midnight because it stores the date, not a flag.
 */
export async function setSoldOut(ctx: RepoContext, id: string, soldOut: boolean): Promise<WriteResult> {
  const today = restaurantDay(ctx.now).date;
  const value = soldOut ? today : null;
  const item = await getMenuItem(ctx, id);
  if (!item) return { ok: false, error: "not-found" };
  // A repeated tap (or a resubmitted form) changes nothing, so it writes nothing.
  if (item.soldOutOn === value) return { ok: true };
  const changed = await commitIf(
    ctx,
    stmt(
      "UPDATE menu_items SET sold_out_on = ?, updated_at = ?, updated_by = ? WHERE site_id = ? AND id = ? AND sold_out_on IS NOT ?",
      value,
      isoSeconds(ctx.now),
      ctx.userId,
      ctx.siteId,
      id,
      value,
    ),
    { entity: "menu_item", entityId: id, action: "update", summary: `${item.name.sv}: ${soldOut ? `sold out ${today}` : "back on sale"}` },
  );
  // Zero rows here means someone else set the same value in between: still the outcome asked for.
  return changed || (await getMenuItem(ctx, id))?.soldOutOn === value ? { ok: true } : { ok: false, error: "not-found" };
}

/** Delete a dish; its home-page highlight goes with it (foreign key cascade). */
export async function deleteMenuItem(ctx: RepoContext, id: string): Promise<WriteResult> {
  const item = await getMenuItem(ctx, id);
  if (!item) return { ok: false, error: "not-found" };
  const changed = await commitIf(ctx, stmt("DELETE FROM menu_items WHERE site_id = ? AND id = ?", ctx.siteId, id), {
    entity: "menu_item",
    entityId: id,
    action: "delete",
    summary: `${item.name.sv}: deleted`,
  });
  return changed ? { ok: true } : { ok: false, error: "not-found" };
}
