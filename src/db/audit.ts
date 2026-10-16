/**
 * The admin's change history (ADR-011 plan M5.6): the latest entries of the site's audit
 * log, newest first, with the email of whoever made each change. "Newest" is commit order
 * (the row id), not the timestamp, which comes from whichever clock wrote the row.
 */
import type { RepoContext } from "./repository";

export interface Change {
  at: string;
  entity: string;
  action: string;
  summary: string;
  /** Null for changes made outside the admin: the seed CLI or the operator. */
  by: string | null;
}

export const HISTORY_LIMIT = 50;

export async function recentChanges(ctx: RepoContext, limit = HISTORY_LIMIT): Promise<Change[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT a.at, a.entity, a.action, a.summary, u.email AS by_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.site_id = ?
       ORDER BY a.id DESC
       LIMIT ?`,
    )
    .bind(ctx.siteId, limit)
    .all<{ at: string; entity: string; action: string; summary: string; by_email: string | null }>();
  return results.map((r) => ({ at: r.at, entity: r.entity, action: r.action, summary: r.summary, by: r.by_email }));
}
