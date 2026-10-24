/**
 * Undo for a deleted dish (ADR-018): reading side. A `menu_item` `delete` entry in the audit
 * log carries a JSON snapshot of the dish, built in SQL from the row as it was deleted
 * (`deleteMenuItem` in repository.ts). This module parses that snapshot and says whether an
 * entry can still be undone. It writes nothing: the restore lives in repository.ts.
 */
import { z } from "zod";
import { menuItemSchema } from "../content/schema";
import type { RepoContext } from "./repository";

/**
 * The audit row id as it arrives from a form: digits only, no leading zero, 15 at most, so
 * Number() reads it exactly (16 digits can pass Number.MAX_SAFE_INTEGER; review L10).
 */
export const ENTRY_ID = /^[1-9][0-9]{0,14}$/;
const ID = /^[a-z0-9]{12}$/;
const IMAGE_ID = /^[0-9a-f]{64}$/;

/** What a delete saved, as `deleteMenuItem` writes it (`v: 1`). */
export const snapshotSchema = (site: string) =>
  z.strictObject({
    v: z.literal(1),
    item: menuItemSchema(site).omit({ image: true }),
    categoryId: z.string().regex(ID),
    categorySlug: z.string().min(1),
    position: z.number().int().min(0),
    soldOutOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    imageId: z.string().regex(IMAGE_ID).nullable(),
    rowVersion: z.number().int().min(0),
    /** The dish's place among the home-page highlights, or null if it wasn't one. */
    highlight: z.number().int().min(0).nullable(),
  });

export type Snapshot = z.output<ReturnType<typeof snapshotSchema>>;

/**
 * The snapshot, re-checked against today's content schema (it may have tightened since the
 * delete) and against the entry it belongs to. Null means the dish can't be restored as it was.
 */
export function parseSnapshot(payload: string | null, site: string, entityId: string | null): Snapshot | null {
  if (payload === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const checked = snapshotSchema(site).safeParse(json);
  if (!checked.success || checked.data.item.id !== entityId) return null;
  return checked.data;
}

/**
 * Where a restored dish goes: its category by id, else by slug (an export restore or a re-seed
 * gives categories new ids), else the owner's choice. Null means the owner must choose.
 */
export async function categoryFor(ctx: RepoContext, snapshot: Snapshot, chosen?: string): Promise<string | null> {
  return (await ctx.db
    .prepare(
      `SELECT id FROM menu_categories WHERE site_id = ?1 AND id = ?2
       UNION ALL SELECT id FROM menu_categories WHERE site_id = ?1 AND slug = ?3
       UNION ALL SELECT id FROM menu_categories WHERE site_id = ?1 AND id = ?4
       LIMIT 1`,
    )
    .bind(ctx.siteId, snapshot.categoryId, snapshot.categorySlug, chosen && ID.test(chosen) ? chosen : "")
    .first<string>("id")) as string | null;
}

export interface UndoableEntry {
  id: number;
  entityId: string;
  payload: string;
}

/**
 * The SQL that says an audit row `a` can still be undone (ADR-018 §3): a dish delete with a
 * snapshot, whose dish doesn't exist now, with no later audit row of this site for the same
 * dish. The restore's own audit row is such a later row, so an entry is undone at most once,
 * and a dish deleted, restored and deleted again offers only the newest delete.
 * The subquery on `audit_log b` is what the index `audit_log_entity` (migration 0007) serves.
 */
export const UNDOABLE = `a.entity = 'menu_item' AND a.action = 'delete' AND a.payload IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.site_id = a.site_id AND m.id = a.entity_id)
  AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.site_id = a.site_id AND b.entity = a.entity AND b.entity_id = a.entity_id AND b.id > a.id)`;

/**
 * The entry, if it is this site's and still undoable. Another site's entry, a non-delete
 * entry, a purged one, a malformed id and a missing one all read the same: null.
 */
export async function undoableEntry(ctx: RepoContext, entryId: string): Promise<UndoableEntry | null> {
  if (!ENTRY_ID.test(entryId)) return null;
  const row = await ctx.db
    .prepare(`SELECT a.id, a.entity_id, a.payload FROM audit_log a WHERE a.id = ? AND a.site_id = ? AND ${UNDOABLE}`)
    .bind(Number(entryId), ctx.siteId)
    .first<{ id: number; entity_id: string; payload: string }>();
  return row ? { id: row.id, entityId: row.entity_id, payload: row.payload } : null;
}
