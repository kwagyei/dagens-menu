/**
 * The operator's purge (ADR-016.2): rows the app already refuses, and history past its
 * retention. Run by `npm run admin -- purge --site <id> [--remote] [--dry-run]`, once a month
 * per site (docs/deploy-runbook.md). No cron (ADR-012), and no purge in the sign-in batch
 * (ADR-016.1 was cut on 2026-10-18).
 *
 * Each rule is the exact negation of the check that accepts the row, so nothing the app would
 * still accept is deleted:
 * - sessions: getSession accepts expires_at > now AND last_seen_at > now − 14 d (idle), so
 *   expired and idle-dead sessions go;
 * - invites: findInvite accepts expires_at > now (and unused), so expired invites go, used or not;
 * - used_challenges: a challenge row only has to outlive its 5-minute cookie: expires_at < now.
 * Plus history older than AUDIT_RETENTION_DAYS (ADR-011 §5), with one audit row saying so, and
 * rate_limits windows older than 24 h (unused today, so a no-op; window_start is Unix seconds).
 *
 * Everything is scoped to one site except rate_limits, which has no site column.
 */
import { isoSeconds } from "../db/repository";
import { type Statement, stmt } from "../db/sql";
import { SESSION_IDLE_MS } from "./sessions";

export const AUDIT_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Rule {
  table: string;
  /** The condition, with `?` placeholders for `params`. */
  where: string;
  params: Array<string | number>;
}

function rules(site: string, now: Date): Rule[] {
  const at = isoSeconds(now);
  return [
    { table: "sessions", where: "site_id = ? AND (expires_at <= ? OR last_seen_at <= ?)", params: [site, at, isoSeconds(new Date(now.getTime() - SESSION_IDLE_MS))] },
    { table: "invites", where: "site_id = ? AND expires_at <= ?", params: [site, at] },
    { table: "used_challenges", where: "site_id = ? AND expires_at < ?", params: [site, at] },
    { table: "audit_log", where: "site_id = ? AND at < ?", params: [site, isoSeconds(new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS))] },
    { table: "rate_limits", where: "window_start < ?", params: [Math.floor(now.getTime() / 1000) - 24 * 60 * 60] },
  ];
}

export type PurgeCounts = Record<"sessions" | "invites" | "used_challenges" | "audit_log" | "rate_limits", number>;

/** One statement whose single row holds the number of rows each table would lose. */
export function purgeCountStatement(site: string, now: Date): Statement {
  const all = rules(site, now);
  return stmt(`SELECT ${all.map((r) => `(SELECT count(*) FROM ${r.table} WHERE ${r.where}) AS ${r.table}`).join(", ")}`, ...all.flatMap((r) => r.params));
}

/**
 * The purge, as one batch. The history note is written first, while the old rows can still be
 * counted, and only if there are any; it is dated now, so the purge never removes it.
 */
export function purgeStatements(site: string, now: Date): Statement[] {
  const all = rules(site, now);
  const audit = all.find((r) => r.table === "audit_log")!;
  const note = stmt(
    `INSERT INTO audit_log (site_id, user_id, at, entity, entity_id, action, summary)
     SELECT ?, NULL, ?, 'audit_log', NULL, 'delete', 'history older than ${AUDIT_RETENTION_DAYS} days removed: ' || n || CASE WHEN n = 1 THEN ' entry' ELSE ' entries' END
     FROM (SELECT count(*) AS n FROM audit_log WHERE ${audit.where}) WHERE n > 0`,
    site,
    isoSeconds(now),
    ...audit.params,
  );
  return [note, ...all.map((r) => stmt(`DELETE FROM ${r.table} WHERE ${r.where}`, ...r.params))];
}
