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
import { sign, unsign } from "./crypto";
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
 * the passkey only if the invite was still unused, and sign in only if the passkey was stored.
 */
export async function enrolVerify(ctx: CeremonyContext, inviteToken: string, response: unknown): Promise<ApiResult> {
  const invite = await findInvite(ctx.db, ctx.site, inviteToken, ctx.now);
  if (!invite) return refuse(410, "invite-invalid");
  const credential = await verifiedRegistration(ctx, `enrol:${invite.tokenHash}`, response);
  if (!credential) return refuse(400, "verification-failed");
  const session = await newSession(invite.userId, ctx.site, ctx.now, true);
  const results = await ctx.db.batch(
    prepare(ctx.db, [consumeInviteStatement(ctx.site, invite.tokenHash, ctx.now), passkeyInsert(ctx, invite.userId, credential, true), session.statement]),
  );
  if (results[0].meta.changes !== 1 || results[2].meta.changes !== 1) return refuse(410, "invite-invalid");
  return ok({ ok: true }, [clearChallenge, sessionCookie(session.token, session.expiresAt)]);
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
  const session = await newSession(row.user_id, ctx.site, ctx.now);
  await ctx.db.batch(
    prepare(ctx.db, [
      stmt("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", newCounter, isoSeconds(ctx.now), row.id),
      session.statement,
    ]),
  );
  return ok({ ok: true }, [clearChallenge, sessionCookie(session.token, session.expiresAt)]);
}

/** Adding another device while signed in (Admin → Security). */
export async function addPasskeyOptions(ctx: CeremonyContext, session: Session): Promise<ApiResult> {
  return registrationOptionsFor(ctx, session.userId, session.email, `add:${session.tokenHash}`);
}

export async function addPasskeyVerify(ctx: CeremonyContext, session: Session, response: unknown): Promise<ApiResult> {
  const credential = await verifiedRegistration(ctx, `add:${session.tokenHash}`, response);
  if (!credential) return refuse(400, "verification-failed");
  await ctx.db.batch(prepare(ctx.db, [passkeyInsert(ctx, session.userId, credential, false)]));
  return ok({ ok: true }, [clearChallenge]);
}
