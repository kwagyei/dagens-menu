/**
 * Audit entries for security events (ADR-011 §6, reviewer M3): enrolment, invites, adding
 * and removing a passkey, signing out everywhere and revoking access. They go into the same
 * audit_log as content changes, so Admin → History shows them, and each is written in the
 * same batch as the event it records.
 *
 * Summaries name the person by email and say what happened. They never hold a token, a
 * token hash or a credential id: the history is shown to every owner of the site.
 */
import { isoSeconds } from "../db/repository";
import { type SqlValue, type Statement, stmt } from "../db/sql";

/** The security events, as audit entity/action pairs; Admin → History labels each in sv and en. */
export const SECURITY_EVENTS = [
  { entity: "invite", action: "create" }, // the operator issued an enrolment link
  { entity: "invite", action: "update" }, // an invite was used to create a passkey
  { entity: "passkey", action: "create" }, // another device added from Admin → Security
  { entity: "passkey", action: "delete" },
  { entity: "sessions", action: "delete" }, // signed out everywhere
  { entity: "membership", action: "delete" }, // the operator revoked access
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

export interface SecurityAudit {
  site: string;
  /** Who did it; null for the operator CLI. */
  actor: string | null;
  /** Whose account it concerns (a user id, never a credential id). */
  subject: string | null;
  now: Date;
  event: SecurityEvent;
}

const COLUMNS = "site_id, user_id, at, entity, entity_id, action, summary";

const values = (a: SecurityAudit): SqlValue[] => [a.site, a.actor, isoSeconds(a.now), a.event.entity, a.subject, a.event.action];

/** An unconditional audit insert with a fixed summary. */
export function securityAudit(a: SecurityAudit, summary: string): Statement {
  return stmt(`INSERT INTO audit_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, ...values(a), summary);
}

/**
 * An audit insert whose summary is a SQL expression evaluated inside the batch (e.g. a count
 * of the sessions about to be ended), written only when `condition` holds. Both are SQL
 * fragments with their own parameters, built with stmt().
 */
export function securityAuditWhere(a: SecurityAudit, summary: Statement, condition: Statement): Statement {
  return stmt(
    `INSERT INTO audit_log (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ${summary.sql} WHERE ${condition.sql}`,
    ...values(a),
    ...summary.params,
    ...condition.params,
  );
}
