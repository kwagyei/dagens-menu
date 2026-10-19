/**
 * Reviewer M3 and M7 (2026-10-17): security events write an audit row (ADR-011 §6), and
 * removing a passkey ends the sessions made with it. Driven through the real ceremony
 * functions with the software authenticator, so the sessions are the ones a browser gets.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/crypto";
import { issueInvite, revokeStatements } from "../../src/auth/invites";
import {
  addPasskeyVerify,
  type CeremonyContext,
  enrolOptions,
  enrolVerify,
  loginOptions,
  loginVerify,
  removePasskey,
} from "../../src/auth/passkeys";
import { getSession, type Session, signOutEverywhere } from "../../src/auth/sessions";
import { recentChanges } from "../../src/db/audit";
import { prepare, stmt } from "../../src/db/sql";
import { confirmedAddOptions } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const SECRET = "m".repeat(32);
const now = new Date("2026-10-17T10:00:00Z");
const BISTRO = { site: "bistro", origin: "https://bistro.example", rpID: "bistro.example" };
const OWNER = "owner@bistro.se";

const ctx = (challengeCookie?: string): CeremonyContext => ({
  db,
  site: BISTRO.site,
  siteName: "Bistro Norden",
  secret: SECRET,
  origin: BISTRO.origin,
  rpID: BISTRO.rpID,
  now,
  challengeCookie,
});

const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");
const sessionToken = (cookies: string[]) => cookieValue(cookies.find((c) => c.startsWith("__Host-dm_admin="))!);
const session = async (token: string) => (await getSession(db, "bistro", token, now))!;

interface AuditRow {
  user_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  summary: string;
}
const auditRows = async () => (await db.prepare("SELECT user_id, entity, entity_id, action, summary FROM audit_log ORDER BY id").all<AuditRow>()).results;
const userId = async (email = OWNER) => (await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<string>("id"))!;
const sessionCount = async () => (await db.prepare("SELECT count(*) AS n FROM sessions").first<number>("n"))!;

async function invite(email = OWNER) {
  const issued = await issueInvite("bistro", email, now);
  await db.batch(prepare(db, issued.statements));
  return issued.token;
}

/** Enrol a new authenticator from a fresh invite; returns it and its session token. */
async function enrol(email = OWNER, auth = new SoftAuthenticator()) {
  const token = await invite(email);
  const options = await enrolOptions(ctx(), token);
  const response = await auth.register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
  const result = await enrolVerify(ctx(cookieValue(options.cookies[0])), token, response);
  expect(result.status).toBe(200);
  return { auth, token: sessionToken(result.cookies) };
}

async function login(auth: SoftAuthenticator) {
  const options = await loginOptions(ctx());
  const challenge = (options.body.options as { challenge: string }).challenge;
  const result = await loginVerify(ctx(cookieValue(options.cookies[0])), await auth.assert(challenge, BISTRO.origin, BISTRO.rpID));
  expect(result.status).toBe(200);
  return sessionToken(result.cookies);
}

async function addDevice(signedIn: Session, auth = new SoftAuthenticator()) {
  const options = await confirmedAddOptions((c) => ctx(c), signedIn, BISTRO.origin, BISTRO.rpID);
  const response = await auth.register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
  const result = await addPasskeyVerify(ctx(cookieValue(options.cookies[0])), signedIn, response);
  expect(result.status).toBe(200);
  return auth;
}

/** A session as created before migration 0004, with no passkey recorded. */
async function legacySession(email = OWNER) {
  const token = "L".repeat(32) + Math.random().toString(36).slice(2, 13).padEnd(11, "x");
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', ?, ?, ?)")
    .bind(await sha256Hex(token), await userId(email), "2026-10-17T09:00:00Z", "2026-10-17T09:00:00Z", "2026-11-16T09:00:00Z")
    .run();
  return token;
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro')")]);
});

describe("M3: security events are audited", () => {
  it("an invite from the operator: no actor, the owner's email, never the token", async () => {
    const token = await invite();
    const rows = await auditRows();
    expect(rows).toEqual([
      { user_id: null, entity: "invite", entity_id: await userId(), action: "create", summary: `${OWNER}: invited as owner; link valid 72 hours` },
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(await sha256Hex(token));
  });

  it("enrolment names the owner as the actor and says it was their first passkey", async () => {
    const { auth } = await enrol();
    const rows = await auditRows();
    expect(rows.at(-1)).toEqual({
      user_id: await userId(),
      entity: "invite",
      entity_id: await userId(),
      action: "update",
      summary: `${OWNER}: first passkey created from the invite`,
    });
    expect(JSON.stringify(rows)).not.toContain(auth.id);
  });

  it("a re-invite and the passkey made from it are recorded as a recovery", async () => {
    await enrol();
    await enrol(OWNER, new SoftAuthenticator());
    const rows = await auditRows();
    expect(rows.map((r) => `${r.entity}.${r.action}: ${r.summary}`)).toEqual([
      `invite.create: ${OWNER}: invited as owner; link valid 72 hours`,
      `invite.update: ${OWNER}: first passkey created from the invite`,
      `invite.create: ${OWNER}: invited again (recovery), already has a passkey; link valid 72 hours`,
      `invite.update: ${OWNER}: passkey created from a new invite (recovery); passkeys now: 2`,
    ]);
  });

  it("an enrolment that fails writes no audit row", async () => {
    const token = await invite();
    const options = await enrolOptions(ctx(), token);
    const response = await new SoftAuthenticator().register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
    expect((await enrolVerify(ctx(cookieValue(options.cookies[0])), token, response)).status).toBe(200);
    // Replaying the same response: the invite is used up.
    expect((await enrolVerify(ctx(cookieValue(options.cookies[0])), token, response)).status).toBe(410);
    expect((await auditRows()).filter((r) => r.action === "update")).toHaveLength(1);
  });

  it("adding a device, and only a successful one", async () => {
    const { token } = await enrol();
    const signedIn = await session(token);
    const second = await addDevice(signedIn);
    // Registering the same credential again is refused, and not audited.
    const options = await confirmedAddOptions((c) => ctx(c), signedIn, BISTRO.origin, BISTRO.rpID);
    const again = await second.register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
    expect(await addPasskeyVerify(ctx(cookieValue(options.cookies[0])), signedIn, again)).toMatchObject({ status: 409, body: { error: "already-registered" } });
    const added = (await auditRows()).filter((r) => r.entity === "passkey" && r.action === "create");
    expect(added).toEqual([
      { user_id: await userId(), entity: "passkey", entity_id: await userId(), action: "create", summary: `${OWNER}: another device's passkey added` },
    ]);
    expect(JSON.stringify(added)).not.toContain(second.id);
  });

  it("removing a passkey names its date and how many sign-ins ended, never its id", async () => {
    const { token } = await enrol();
    const second = await addDevice(await session(token));
    await login(second);
    await login(second);
    expect(await removePasskey(db, await session(token), second.id, now)).toBe("removed");
    const rows = await auditRows();
    expect(rows.at(-1)).toEqual({
      user_id: await userId(),
      entity: "passkey",
      entity_id: await userId(),
      action: "delete",
      summary: `${OWNER}: passkey from 2026-10-17 removed; sign-ins ended: 2`,
    });
    expect(JSON.stringify(rows)).not.toContain(second.id);
  });

  it("a removal that doesn't happen writes no audit row", async () => {
    const { auth, token } = await enrol();
    const before = (await auditRows()).length;
    expect(await removePasskey(db, await session(token), auth.id, now)).toBe("not-removed"); // the only one
    expect(await removePasskey(db, await session(token), "no-such-passkey", now)).toBe("not-removed");
    expect(await auditRows()).toHaveLength(before);
  });

  it("signing out everywhere, with the number of sign-ins it ended", async () => {
    const { auth, token } = await enrol();
    await login(auth);
    await signOutEverywhere(db, await session(token), now);
    expect(await sessionCount()).toBe(0);
    expect((await auditRows()).at(-1)).toEqual({
      user_id: await userId(),
      entity: "sessions",
      entity_id: await userId(),
      action: "delete",
      summary: `${OWNER}: signed out everywhere; sign-ins ended: 2`,
    });
  });

  it("revoking access from the CLI", async () => {
    await enrol();
    const id = await userId();
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    expect((await auditRows()).at(-1)).toEqual({
      user_id: null,
      entity: "membership",
      entity_id: id,
      action: "delete",
      summary: `${OWNER}: access revoked; passkeys removed: 1`,
    });
  });

  it("revoking someone without access writes nothing", async () => {
    await db.batch(prepare(db, revokeStatements("bistro", "nobody@bistro.se")));
    expect(await auditRows()).toEqual([]);
  });

  it("the events show in the history, newest first, with who did them", async () => {
    const { token } = await enrol();
    await signOutEverywhere(db, await session(token), now);
    const history = await recentChanges({ db, siteId: "bistro", userId: null, now });
    expect(history.map((c) => [c.entity, c.action, c.by])).toEqual([
      ["sessions", "delete", OWNER],
      ["invite", "update", OWNER],
      ["invite", "create", null],
    ]);
  });

  it("audit rows don't move the content version (public pages stay cached)", async () => {
    const version = () => db.prepare("SELECT content_version FROM sites WHERE id = 'bistro'").first<number>("content_version");
    const before = await version();
    const { token } = await enrol();
    await signOutEverywhere(db, await session(token), now);
    expect(await version()).toBe(before);
  });
});

describe("M7: removing a passkey ends the sessions made with it", () => {
  it("every session records the passkey it was signed in with", async () => {
    const { auth, token } = await enrol();
    expect((await session(token)).passkeyId).toBe(auth.id);
    expect((await session(await login(auth))).passkeyId).toBe(auth.id);
  });

  it("ends that passkey's sessions and keeps the others'", async () => {
    const { auth: phone, token: phoneSession } = await enrol();
    const laptop = await addDevice(await session(phoneSession));
    const laptopSessions = [await login(laptop), await login(laptop)];
    const phoneLogin = await login(phone);
    expect(await removePasskey(db, await session(phoneSession), laptop.id, now)).toBe("removed");
    for (const t of laptopSessions) expect(await getSession(db, "bistro", t, now)).toBeNull();
    expect(await getSession(db, "bistro", phoneSession, now)).not.toBeNull();
    expect(await getSession(db, "bistro", phoneLogin, now)).not.toBeNull();
  });

  it("removing the passkey this session was made with ends this session too", async () => {
    const { auth: phone, token } = await enrol();
    await addDevice(await session(token));
    expect(await removePasskey(db, await session(token), phone.id, now)).toBe("signed-out");
    expect(await getSession(db, "bistro", token, now)).toBeNull();
  });

  it("is a database guarantee: deleting the passkey row cascades to its sessions", async () => {
    const { auth, token } = await enrol();
    await db.prepare("DELETE FROM passkeys WHERE id = ?").bind(auth.id).run();
    expect(await getSession(db, "bistro", token, now)).toBeNull();
  });

  it("sessions from before the migration: the others end, the one removing stays", async () => {
    const { token } = await enrol();
    const second = await addDevice(await session(token));
    const current = await legacySession();
    const other = await legacySession();
    expect((await session(current)).passkeyId).toBeNull();
    expect(await removePasskey(db, await session(current), second.id, now)).toBe("removed");
    expect(await getSession(db, "bistro", other, now)).toBeNull();
    expect(await getSession(db, "bistro", current, now)).not.toBeNull();
    // A session made with a passkey that stays is untouched.
    expect(await getSession(db, "bistro", token, now)).not.toBeNull();
  });

  it("another owner's sessions are untouched, old or new", async () => {
    const { token } = await enrol();
    const second = await addDevice(await session(token));
    const { token: colleague } = await enrol("chef@bistro.se");
    const colleagueLegacy = await legacySession("chef@bistro.se");
    expect(await removePasskey(db, await session(token), second.id, now)).toBe("removed");
    expect(await getSession(db, "bistro", colleague, now)).not.toBeNull();
    expect(await getSession(db, "bistro", colleagueLegacy, now)).not.toBeNull();
  });

  it("a refused removal ends nothing, not even sessions from before the migration", async () => {
    const { auth, token } = await enrol();
    const current = await legacySession();
    const other = await legacySession();
    expect(await removePasskey(db, await session(current), auth.id, now)).toBe("not-removed"); // the only one
    expect(await removePasskey(db, await session(current), "no-such-passkey", now)).toBe("not-removed");
    for (const t of [token, current, other]) expect(await getSession(db, "bistro", t, now)).not.toBeNull();
  });

  it("can't remove another owner's passkey", async () => {
    const { token } = await enrol();
    await addDevice(await session(token));
    const { auth: chef, token: chefSession } = await enrol("chef@bistro.se");
    await addDevice(await session(chefSession));
    expect(await removePasskey(db, await session(token), chef.id, now)).toBe("not-removed");
    expect(await getSession(db, "bistro", chefSession, now)).not.toBeNull();
    expect(await db.prepare("SELECT count(*) AS n FROM passkeys WHERE id = ?").bind(chef.id).first<number>("n")).toBe(1);
  });

  it("old code that inserts without a passkey still works (expand-only migration)", async () => {
    await enrol();
    await db.batch(
      prepare(db, [
        stmt(
          "INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', ?, ?, ?)",
          "a".repeat(64),
          await userId(),
          "2026-10-17T09:00:00Z",
          "2026-10-17T09:00:00Z",
          "2026-11-16T09:00:00Z",
        ),
      ]),
    );
    expect(await db.prepare("SELECT passkey_id FROM sessions WHERE token_hash = ?").bind("a".repeat(64)).first("passkey_id")).toBeNull();
  });
});
