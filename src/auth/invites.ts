/**
 * Owner accounts are created only by the operator (ADR-011 §6): there is no sign-up. An
 * invite is a single-use link valid for 72 hours; the database keeps only the SHA-256 of
 * its token, so a leaked database can't be used to enrol.
 *
 * Statements are plain data, as in the seed: the CLI renders them for wrangler, the Worker
 * and tests run them through the D1 binding.
 */
import { newId } from "../db/ids";
import { isoSeconds } from "../db/repository";
import { type Statement, stmt } from "../db/sql";
import type { D1Database } from "../db/types";
import { randomToken, sha256Hex } from "./crypto";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface IssuedInvite {
  /** The token for the link. Shown once, never stored. */
  token: string;
  statements: Statement[];
}

/**
 * Create the user if needed, make them an owner of `site` and issue an invite. Re-inviting
 * the same email adds a fresh invite (e.g. to recover access); earlier unused ones stay
 * valid until they expire.
 */
export async function issueInvite(site: string, email: string, now: Date): Promise<IssuedInvite> {
  const normalised = email.trim().toLowerCase();
  if (!EMAIL.test(normalised)) throw new Error(`"${email}" is not an email address.`);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  return {
    token,
    statements: [
      stmt("INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (email) DO NOTHING", newId(), normalised),
      stmt(
        "INSERT INTO memberships (user_id, site_id, role) SELECT id, ?, 'owner' FROM users WHERE email = ? ON CONFLICT (user_id, site_id) DO NOTHING",
        site,
        normalised,
      ),
      stmt(
        "INSERT INTO invites (token_hash, user_id, site_id, created_at, expires_at) SELECT ?, id, ?, ?, ? FROM users WHERE email = ?",
        tokenHash,
        site,
        isoSeconds(now),
        isoSeconds(new Date(now.getTime() + INVITE_TTL_MS)),
        normalised,
      ),
    ],
  };
}

/** Remove someone's access to `site`: membership, passkeys, sessions and invites (cascade). */
export function revokeStatements(site: string, email: string): Statement[] {
  return [stmt("DELETE FROM memberships WHERE site_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)", site, email.trim().toLowerCase())];
}

export interface PendingInvite {
  tokenHash: string;
  userId: string;
  email: string;
}

/** The invite behind `token` if it is for `site`, unused and unexpired; otherwise null. */
export async function findInvite(db: D1Database, site: string, token: string, now: Date): Promise<PendingInvite | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT i.token_hash, i.user_id, u.email FROM invites i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = ? AND i.site_id = ? AND i.used_at IS NULL AND i.expires_at > ?`,
    )
    .bind(tokenHash, site, isoSeconds(now))
    .first<{ token_hash: string; user_id: string; email: string }>();
  return row ? { tokenHash: row.token_hash, userId: row.user_id, email: row.email } : null;
}

/**
 * The guarded statement that uses up an invite. Put it first in the batch that stores the
 * passkey and make that insert conditional on it (`WHERE changes() = 1`), so a replayed or
 * expired invite stores nothing.
 */
export function consumeInviteStatement(site: string, tokenHash: string, now: Date): Statement {
  return stmt(
    "UPDATE invites SET used_at = ? WHERE token_hash = ? AND site_id = ? AND used_at IS NULL AND expires_at > ?",
    isoSeconds(now),
    tokenHash,
    site,
    isoSeconds(now),
  );
}
