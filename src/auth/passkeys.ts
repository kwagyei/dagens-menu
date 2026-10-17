/**
 * Passkey ceremonies for the admin (ADR-011 §6, plan M4.2, M4.3, M4.6).
 *
 * Starting a ceremony writes nothing to D1: the WebAuthn challenge travels in a signed
 * 5-minute cookie whose signature also binds what it is for (this invite, a sign-in, adding a
 * device to this session). Finishing one verifies the browser's response first and only then
 * writes, in one batch.
 *
 * Each function returns status, JSON and cookies; the Astro endpoints only pass them on.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { prepare, stmt } from "../db/sql";
import type { D1Database } from "../db/types";
import { isoSeconds } from "../db/repository";
import { securityAudit, securityAuditWhere } from "./audit";
import { fromBase64url, sign, unsign } from "./crypto";
import { consumeInviteStatement, findInvite } from "./invites";
import { newSession, type Session, sessionCookie } from "./sessions";

export const CHALLENGE_COOKIE = "__Host-dm_challenge";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface CeremonyContext {
  db: D1Database;
  site: string;
  /** Shown in the passkey prompt, e.g. "Bistro Norden". */
  siteName: string;
  secret: string;
  /** The page's origin and host name; passkeys are bound to the host (the RP ID). */
  origin: string;
  rpID: string;
  now: Date;
  /** The challenge cookie sent with this request, if any. */
  challengeCookie: string | undefined;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}

const ok = (body: Record<string, unknown>, cookies: string[] = []): ApiResult => ({ status: 200, body, cookies });
const refuse = (status: number, error: string): ApiResult => ({ status, body: { error }, cookies: [clearChallenge] });

const clearChallenge = `${CHALLENGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

async function challengeCookie(ctx: CeremonyContext, purpose: string, challenge: string): Promise<string> {
  const value = await sign(ctx.secret, purpose, challenge, new Date(ctx.now.getTime() + CHALLENGE_TTL_MS));
  return `${CHALLENGE_COOKIE}=${value}; Path=/; Max-Age=${CHALLENGE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

const expectedChallenge = (ctx: CeremonyContext, purpose: string) =>
  ctx.challengeCookie ? unsign(ctx.secret, purpose, ctx.challengeCookie, ctx.now) : Promise.resolve(null);

const userHandle = (userId: string) => new TextEncoder().encode(userId);

/**
 * Statements that redeem a challenge exactly once: forget expired ones, then record this one.
 * A replay fails the primary key, which aborts the whole batch it's part of.
 */
const redeemChallenge = (ctx: CeremonyContext, challenge: string) => [
  stmt("DELETE FROM used_challenges WHERE expires_at < ?", isoSeconds(ctx.now)),
  stmt(
    "INSERT INTO used_challenges (challenge, site_id, expires_at) VALUES (?, ?, ?)",
    challenge,
    ctx.site,
    isoSeconds(new Date(ctx.now.getTime() + CHALLENGE_TTL_MS)),
  ),
];

const isConstraintError = (error: unknown) => /UNIQUE|PRIMARY KEY|constraint/i.test(String(error));

async function registeredCredentials(ctx: CeremonyContext, userId: string) {
  const { results } = await ctx.db
    .prepare("SELECT id, transports FROM passkeys WHERE user_id = ? AND site_id = ?")
    .bind(userId, ctx.site)
    .all<{ id: string; transports: string }>();
  return results.map((r) => ({ id: r.id, transports: JSON.parse(r.transports) }));
}

async function registrationOptionsFor(ctx: CeremonyContext, userId: string, email: string, purpose: string): Promise<ApiResult> {
  const options = await generateRegistrationOptions({
    rpName: ctx.siteName,
    rpID: ctx.rpID,
    userName: email,
    userID: userHandle(userId),
    attestationType: "none",
    excludeCredentials: await registeredCredentials(ctx, userId),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return ok({ options }, [await challengeCookie(ctx, purpose, options.challenge)]);
}

async function verifiedRegistration(ctx: CeremonyContext, purpose: string, response: unknown) {
  const challenge = await expectedChallenge(ctx, purpose);
  if (!challenge) return null;
  const credential = await verifiedCredential(ctx, challenge, response);
  return credential ? { credential, challenge } : null;
}

async function verifiedCredential(ctx: CeremonyContext, challenge: string, response: unknown) {
  try {
    const result = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: ctx.origin,
      expectedRPID: ctx.rpID,
      requireUserVerification: false,
    });
    return result.verified ? (result.registrationInfo?.credential ?? null) : null;
  } catch {
    return null;
  }
}

function passkeyInsert(ctx: CeremonyContext, userId: string, credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }, conditional: boolean) {
  const values = [credential.id, userId, ctx.site, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), isoSeconds(ctx.now)] as const;
  return conditional
    ? stmt("INSERT INTO passkeys (id, user_id, site_id, public_key, counter, transports, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1", ...values)
    : stmt("INSERT INTO passkeys (id, user_id, site_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ...values);
}

/** Step 1 of enrolment: the invite must be valid; nothing is written. */
export async function enrolOptions(ctx: CeremonyContext, inviteToken: string): Promise<ApiResult> {
  const invite = await findInvite(ctx.db, ctx.site, inviteToken, ctx.now);
  if (!invite) return refuse(410, "invite-invalid");
  return registrationOptionsFor(ctx, invite.userId, invite.email, `enrol:${invite.tokenHash}`);
}

/**
 * Step 2 of enrolment: verify the new passkey, then in one batch use up the invite, store
 * the passkey only if the invite was still unused, sign in only if the passkey was stored,
 * and record it in the audit log only if signed in.
 */
export async function enrolVerify(ctx: CeremonyContext, inviteToken: string, response: unknown): Promise<ApiResult> {
  const invite = await findInvite(ctx.db, ctx.site, inviteToken, ctx.now);
  if (!invite) return refuse(410, "invite-invalid");
  const verified = await verifiedRegistration(ctx, `enrol:${invite.tokenHash}`, response);
  if (!verified) return refuse(400, "verification-failed");
  const session = await newSession(invite.userId, ctx.site, verified.credential.id, ctx.now, true);
  const who = { site: ctx.site, actor: invite.userId, subject: invite.userId, now: ctx.now, event: { entity: "invite", action: "update" } } as const;
  // A second passkey from an invite is a recovery: the operator re-invited someone who had lost theirs.
  const passkeyCount = stmt("(SELECT count(*) FROM passkeys WHERE user_id = ? AND site_id = ?)", invite.userId, ctx.site);
  const summary = stmt(
    `? || CASE WHEN ${passkeyCount.sql} > 1 THEN ': passkey created from a new invite (recovery); passkeys now: ' || ${passkeyCount.sql}
       ELSE ': first passkey created from the invite' END`,
    invite.email,
    ...passkeyCount.params,
    ...passkeyCount.params,
  );
  let results;
  try {
    results = await ctx.db.batch(
      prepare(ctx.db, [
        consumeInviteStatement(ctx.site, invite.tokenHash, ctx.now),
        passkeyInsert(ctx, invite.userId, verified.credential, true),
        session.statement,
        securityAuditWhere(who, summary, stmt("changes() = 1")),
      ]),
    );
  } catch (error) {
    if (isConstraintError(error)) return refuse(409, "already-registered");
    throw error;
  }
  if (results[0].meta.changes !== 1 || results[2].meta.changes !== 1) return refuse(410, "invite-invalid");
  // As in commitIf (src/db/repository.ts): should changes() ever not carry across the batch's
  // statements (reviewer M2), the enrolment still gets its audit row.
  if (results[3].meta.changes === 0) {
    console.warn("audit: an enrolment was stored without its audit row; adding it separately");
    await ctx.db.batch(prepare(ctx.db, [securityAudit(who, `${invite.email}: passkey created from an invite`)]));
  }
  return ok({ ok: true }, [clearChallenge, sessionCookie(session.token, session.expiresAt)]);
}

function handleMatches(handle: string, userId: string): boolean {
  try {
    return new TextDecoder().decode(fromBase64url(handle)) === userId;
  } catch {
    return false;
  }
}

/** Sign-in step 1: a challenge for any passkey of this site (discoverable, no username). */
export async function loginOptions(ctx: CeremonyContext): Promise<ApiResult> {
  const options = await generateAuthenticationOptions({ rpID: ctx.rpID, userVerification: "preferred" });
  return ok({ options }, [await challengeCookie(ctx, "login", options.challenge)]);
}

/** Sign-in step 2: the passkey must belong to a current member of this site. */
export async function loginVerify(ctx: CeremonyContext, response: unknown): Promise<ApiResult> {
  const challenge = await expectedChallenge(ctx, "login");
  if (!challenge) return refuse(400, "challenge-expired");
  const assertion = response as { id?: unknown; response?: { userHandle?: unknown } };
  if (typeof assertion?.id !== "string") return refuse(400, "verification-failed");
  const row = await ctx.db
    .prepare(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports FROM passkeys p
       JOIN memberships m ON m.user_id = p.user_id AND m.site_id = p.site_id
       WHERE p.id = ? AND p.site_id = ?`,
    )
    .bind(assertion.id, ctx.site)
    .first<{ id: string; user_id: string; public_key: ArrayBuffer; counter: number; transports: string }>();
  if (!row) return refuse(401, "unknown-passkey");
  // WebAuthn §7.2: a discoverable sign-in names its user, and it must be the passkey's owner.
  const handle = assertion.response?.userHandle;
  if (typeof handle !== "string" || !handleMatches(handle, row.user_id)) return refuse(401, "verification-failed");
  let newCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin: ctx.origin,
      expectedRPID: ctx.rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
      requireUserVerification: false,
    });
    if (!result.verified) return refuse(401, "verification-failed");
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    // Includes a sign counter that went backwards: a sign of a cloned authenticator.
    return refuse(401, "verification-failed");
  }
  const session = await newSession(row.user_id, ctx.site, row.id, ctx.now);
  try {
    await ctx.db.batch(
      prepare(ctx.db, [
        ...redeemChallenge(ctx, challenge),
        stmt("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", newCounter, isoSeconds(ctx.now), row.id),
        session.statement,
      ]),
    );
  } catch (error) {
    if (isConstraintError(error)) return refuse(401, "challenge-used");
    throw error;
  }
  return ok({ ok: true }, [clearChallenge, sessionCookie(session.token, session.expiresAt)]);
}

/** Adding another device while signed in (Admin → Security). */
export async function addPasskeyOptions(ctx: CeremonyContext, session: Session): Promise<ApiResult> {
  return registrationOptionsFor(ctx, session.userId, session.email, `add:${session.tokenHash}`);
}

export async function addPasskeyVerify(ctx: CeremonyContext, session: Session, response: unknown): Promise<ApiResult> {
  const verified = await verifiedRegistration(ctx, `add:${session.tokenHash}`, response);
  if (!verified) return refuse(400, "verification-failed");
  const audit = securityAudit(
    { site: ctx.site, actor: session.userId, subject: session.userId, now: ctx.now, event: { entity: "passkey", action: "create" } },
    `${session.email}: another device's passkey added`,
  );
  try {
    await ctx.db.batch(
      prepare(ctx.db, [...redeemChallenge(ctx, verified.challenge), passkeyInsert(ctx, session.userId, verified.credential, false), audit]),
    );
  } catch (error) {
    // A replayed challenge, or a passkey that is already registered.
    if (isConstraintError(error)) return refuse(409, "already-registered");
    throw error;
  }
  return ok({ ok: true }, [clearChallenge]);
}

export type RemoveResult = "removed" | "signed-out" | "not-removed";

/**
 * Remove one of the signed-in person's passkeys (Admin → Security), never their last one, and
 * end the sessions made with it (reviewer M7). The foreign key from sessions.passkey_id
 * deletes those in the same statement as the passkey.
 *
 * Sessions from before migration 0004 have no passkey recorded. Any of them could belong to
 * the device being removed, so they are ended too, except the one making this request: the
 * person removing the passkey is plainly at that device. All of them expire by 30 days after
 * the migration, after which this case no longer arises.
 *
 * One batch, and no statement depends on another's changes() (reviewer M2): the audit row
 * and the delete of unattributed sessions repeat the passkey delete's own condition, and run
 * before it while that condition still reads the same.
 */
export async function removePasskey(db: D1Database, session: Session, passkeyId: string, now: Date): Promise<RemoveResult> {
  const { userId, siteId } = session;
  const owned = await db.prepare("SELECT 1 FROM passkeys WHERE id = ? AND user_id = ? AND site_id = ?").bind(passkeyId, userId, siteId).first();
  if (!owned) return "not-removed";
  const removable = stmt(
    "EXISTS (SELECT 1 FROM passkeys WHERE id = ? AND user_id = ? AND site_id = ?) AND (SELECT count(*) FROM passkeys WHERE user_id = ? AND site_id = ?) > 1",
    passkeyId,
    userId,
    siteId,
    userId,
    siteId,
  );
  const unattributed = stmt("user_id = ? AND site_id = ? AND passkey_id IS NULL AND token_hash != ?", userId, siteId, session.tokenHash);
  const summary = stmt(
    `? || ': passkey from ' || (SELECT substr(created_at, 1, 10) FROM passkeys WHERE id = ?) || ' removed; sign-ins ended: ' ||
       (SELECT count(*) FROM sessions WHERE passkey_id = ? OR (${unattributed.sql}))`,
    session.email,
    passkeyId,
    passkeyId,
    ...unattributed.params,
  );
  const who = { site: siteId, actor: userId, subject: userId, now, event: { entity: "passkey", action: "delete" } } as const;
  const results = await db.batch(
    prepare(db, [
      // The audit row first, so its summary can still read the passkey and count its sessions.
      securityAuditWhere(who, summary, removable),
      // Under the same condition as the passkey DELETE, and before it: a removal that loses a
      // race to another one ends nothing, not even the winner's session.
      stmt(`DELETE FROM sessions WHERE ${unattributed.sql} AND ${removable.sql}`, ...unattributed.params, ...removable.params),
      // The last-passkey check is in the DELETE itself, so two removals at once can't both
      // pass it and lock the owner out (recovery is an operator invite).
      stmt(`DELETE FROM passkeys WHERE id = ? AND ${removable.sql}`, passkeyId, ...removable.params),
    ]),
  );
  if (results[2].meta.changes === 0) return "not-removed";
  return session.passkeyId === passkeyId ? "signed-out" : "removed";
}
