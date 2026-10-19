/**
 * The admin's change history (ADR-011 plan M5.6): the latest entries of the site's audit
 * log, newest first, with the email of whoever made each change. "Newest" is commit order
 * (the row id), not the timestamp, which comes from whichever clock wrote the row.
 */
import type { RepoContext } from "./repository";
import { UNDOABLE } from "./undo";

export interface Change {
  /** The audit row, named by the "Ångra" form. */
  id: number;
  at: string;
  entity: string;
  action: string;
  summary: string;
  /** Null for changes made outside the admin: the seed CLI or the operator. */
  by: string | null;
  /** A dish delete whose dish can still be put back (ADR-018). */
  undoable: boolean;
}

export const HISTORY_LIMIT = 50;

export async function recentChanges(ctx: RepoContext, limit = HISTORY_LIMIT): Promise<Change[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT a.id, a.at, a.entity, a.action, a.summary, u.email AS by_email, (${UNDOABLE}) AS undoable
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.site_id = ?
       ORDER BY a.id DESC
       LIMIT ?`,
    )
    .bind(ctx.siteId, limit)
    .all<{ id: number; at: string; entity: string; action: string; summary: string; by_email: string | null; undoable: number }>();
  return results.map((r) => ({ id: r.id, at: r.at, entity: r.entity, action: r.action, summary: r.summary, by: r.by_email, undoable: r.undoable === 1 }));
}
