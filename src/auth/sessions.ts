/**
 * Admin sessions (ADR-011 §6). The cookie holds a random token; the database keeps only its
 * SHA-256, pinned to one site. A session ends after 30 days, or after 14 days unused, or the
 * moment its membership or the passkey it was made with is removed (the foreign keys
 * cascade), and it is checked on every admin request. last_seen_at is written at most once
 * an hour, to spare D1's write budget.
 */
import { isoSeconds } from "../db/repository";
import { securityAuditWhere } from "./audit";
import { prepare, type Statement, stmt } from "../db/sql";
import type { D1Database } from "../db/types";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "__Host-dm_admin";
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface Session {
  tokenHash: string;
  userId: string;
  email: string;
  role: "owner" | "editor";
  siteId: string;
  /** The passkey this session was signed in with; null for sessions from before migration 0004. */
  passkeyId: string | null;
}

export interface NewSession {
  token: string;
  tokenHash: string;
  expiresAt: Date;
  statement: Statement;
}

/** A new session for `userId` on `site`, signed in with `passkeyId`. `onlyIfChanged` makes the
 *  insert conditional on the statement before it in the batch (e.g. the passkey insert
 *  during enrolment). */
export async function newSession(userId: string, site: string, passkeyId: string, now: Date, onlyIfChanged = false): Promise<NewSession> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  const values = [tokenHash, userId, site, passkeyId, isoSeconds(now), isoSeconds(now), isoSeconds(expiresAt)];
  const columns = "token_hash, user_id, site_id, passkey_id, created_at, last_seen_at, expires_at";
  const statement = onlyIfChanged
    ? stmt(`INSERT INTO sessions (${columns}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`, ...values)
    : stmt(`INSERT INTO sessions (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?)`, ...values);
  return { token, tokenHash, expiresAt, statement };
}

/** The session behind a cookie token, if valid for `site` right now; otherwise null. */
export async function getSession(db: D1Database, site: string, token: string | undefined, now: Date): Promise<Session | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.user_id, s.passkey_id, s.last_seen_at, u.email, m.role FROM sessions s
       JOIN memberships m ON m.user_id = s.user_id AND m.site_id = s.site_id
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.site_id = ? AND s.expires_at > ? AND s.last_seen_at > ?`,
    )
    .bind(tokenHash, site, isoSeconds(now), isoSeconds(new Date(now.getTime() - SESSION_IDLE_MS)))
    .first<{ user_id: string; passkey_id: string | null; last_seen_at: string; email: string; role: "owner" | "editor" }>();
  if (!row) return null;
  if (now.getTime() - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
    await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(isoSeconds(now), tokenHash).run();
  }
  return { tokenHash, userId: row.user_id, email: row.email, role: row.role, siteId: site, passkeyId: row.passkey_id };
}

export function endSessionStatement(tokenHash: string): Statement {
  return stmt("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
}

export function endAllSessionsStatement(userId: string, site: string): Statement {
  return stmt("DELETE FROM sessions WHERE user_id = ? AND site_id = ?", userId, site);
}

/**
 * "Sign out everywhere" (Admin → Security): end all of this person's sessions on the site,
 * this one included, and record it in the audit log in the same batch. The audit row comes
 * first so that its summary can count the sessions it is about to end.
 */
export async function signOutEverywhere(db: D1Database, session: Session, now: Date): Promise<void> {
  const audit = securityAuditWhere(
    { site: session.siteId, actor: session.userId, subject: session.userId, now, event: { entity: "sessions", action: "delete" } },
    stmt("? || ': signed out everywhere; sign-ins ended: ' || (SELECT count(*) FROM sessions WHERE user_id = ? AND site_id = ?)", session.email, session.userId, session.siteId),
    stmt("1"),
  );
  await db.batch(prepare(db, [audit, endAllSessionsStatement(session.userId, session.siteId)]));
}

/** Set-Cookie for a session: __Host- requires Secure, Path=/ and no Domain. */
export function sessionCookie(token: string, expiresAt: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** A cookie's value from a Cookie header. */
export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
