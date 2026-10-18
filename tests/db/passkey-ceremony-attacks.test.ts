/**
 * Tester, M4 (ADR-011 §6, answer 7): the passkey ceremonies driven end to end inside workerd
 * by a software authenticator, so that successful verifications can be replayed, raced and
 * pointed at the wrong site, which the browser's virtual authenticator can't do.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { base64url, sha256Hex, sign } from "../../src/auth/crypto";
import { findInvite, issueInvite, revokeStatements } from "../../src/auth/invites";
import {
  addPasskeyVerify,
  type CeremonyContext,
  enrolOptions,
  enrolVerify,
  loginOptions,
  loginVerify,
} from "../../src/auth/passkeys";
import { getSession } from "../../src/auth/sessions";
import { prepare } from "../../src/db/sql";
import { confirmedAddOptions } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const SECRET = "t".repeat(32);
const now = new Date("2026-10-16T10:00:00Z");
const enc = new TextEncoder();

// ---------------------------------------------------------------------------------------

const BISTRO = { site: "bistro", origin: "https://bistro.example", rpID: "bistro.example" };
const WEST = { site: "westafrican", origin: "https://westafrican.example", rpID: "westafrican.example" };

const ctx = (where = BISTRO, challengeCookie?: string, at = now): CeremonyContext => ({
  db,
  site: where.site,
  siteName: where.site,
  secret: SECRET,
  origin: where.origin,
  rpID: where.rpID,
  now: at,
  challengeCookie,
});

/** The cookie value from a Set-Cookie string. */
const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");
const sessionToken = (cookies: string[]) => cookieValue(cookies.find((c) => c.startsWith("__Host-dm_admin="))!);
const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"))!;

async function invite(site = "bistro", email = "owner@bistro.se") {
  const issued = await issueInvite(site, email, now);
  await db.batch(prepare(db, issued.statements));
  return issued.token;
}

/** Enrol a fresh authenticator through the real functions; returns it and the session token. */
async function enrol(where = BISTRO, email = "owner@bistro.se", auth = new SoftAuthenticator()) {
  const token = await invite(where.site, email);
  const options = await enrolOptions(ctx(where), token);
  expect(options.status).toBe(200);
  const cookie = cookieValue(options.cookies[0]);
  const response = await auth.register(options.body.options as never, where.origin, where.rpID);
  const result = await enrolVerify(ctx(where, cookie), token, response);
  expect(result.status).toBe(200);
  return { auth, token, session: sessionToken(result.cookies) };
}

async function login(auth: SoftAuthenticator, where = BISTRO, opts: { counter?: number; userHandle?: string } = {}) {
  const options = await loginOptions(ctx(where));
  const cookie = cookieValue(options.cookies[0]);
  const challenge = (options.body.options as { challenge: string }).challenge;
  const response = await auth.assert(challenge, where.origin, where.rpID, opts);
  return { result: await loginVerify(ctx(where, cookie), response), cookie, response };
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')")]);
});

describe("software authenticator sanity", () => {
  it("enrols and signs in through the real ceremony functions", async () => {
    const { auth, session } = await enrol();
    expect(await getSession(db, "bistro", session, now)).not.toBeNull();
    const { result } = await login(auth);
    expect(result.status).toBe(200);
    expect(await count("passkeys")).toBe(1);
    expect(await count("sessions")).toBe(2);
  });
});

describe("enrolment: atomicity and replay", () => {
  it("two devices racing on one invite: exactly one passkey and one session are stored", async () => {
    const token = await invite();
    const a = new SoftAuthenticator();
    const b = new SoftAuthenticator();
    const optA = await enrolOptions(ctx(), token);
    const optB = await enrolOptions(ctx(), token);
    const respA = await a.register(optA.body.options as never, BISTRO.origin, BISTRO.rpID);
    const respB = await b.register(optB.body.options as never, BISTRO.origin, BISTRO.rpID);
    const results = await Promise.all([
      enrolVerify(ctx(BISTRO, cookieValue(optA.cookies[0])), token, respA),
      enrolVerify(ctx(BISTRO, cookieValue(optB.cookies[0])), token, respB),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(await count("passkeys")).toBe(1);
    expect(await count("sessions")).toBe(1);
    const loser = results.find((r) => r.status === 410)!;
    expect(loser.cookies.some((c) => c.startsWith("__Host-dm_admin="))).toBe(false);
  });

  it("the losing device of that race stores nothing even when the batches run one after another", async () => {
    const token = await invite();
    const a = new SoftAuthenticator();
    const b = new SoftAuthenticator();
    const optA = await enrolOptions(ctx(), token);
    const optB = await enrolOptions(ctx(), token);
    const respA = await a.register(optA.body.options as never, BISTRO.origin, BISTRO.rpID);
    const respB = await b.register(optB.body.options as never, BISTRO.origin, BISTRO.rpID);
    expect((await enrolVerify(ctx(BISTRO, cookieValue(optA.cookies[0])), token, respA)).status).toBe(200);
    expect((await enrolVerify(ctx(BISTRO, cookieValue(optB.cookies[0])), token, respB)).status).toBe(410);
    const ids = (await db.prepare("SELECT id FROM passkeys").all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual([a.id]);
  });

  it("replaying a successful enrolment response (same cookie, same body) is refused", async () => {
    const token = await invite();
    const auth = new SoftAuthenticator();
    const opt = await enrolOptions(ctx(), token);
    const cookie = cookieValue(opt.cookies[0]);
    const resp = await auth.register(opt.body.options as never, BISTRO.origin, BISTRO.rpID);
    expect((await enrolVerify(ctx(BISTRO, cookie), token, resp)).status).toBe(200);
    expect((await enrolVerify(ctx(BISTRO, cookie), token, resp)).status).toBe(410);
    expect(await count("sessions")).toBe(1);
  });

  it("an expired (5-minute) challenge cookie is refused and the invite stays usable", async () => {
    const token = await invite();
    const opt = await enrolOptions(ctx(), token);
    const resp = await new SoftAuthenticator().register(opt.body.options as never, BISTRO.origin, BISTRO.rpID);
    const late = new Date(now.getTime() + 5 * 60_000 + 1000);
    expect((await enrolVerify(ctx(BISTRO, cookieValue(opt.cookies[0]), late), token, resp)).status).toBe(400);
    expect(await findInvite(db, "bistro", token, late)).not.toBeNull();
  });

  it("a sign-in challenge cookie can't be used to enrol", async () => {
    const token = await invite();
    const opt = await enrolOptions(ctx(), token);
    const challenge = (opt.body.options as { challenge: string }).challenge;
    const loginCookie = await sign(SECRET, "login", challenge, new Date(now.getTime() + 60_000));
    const resp = await new SoftAuthenticator().register(opt.body.options as never, BISTRO.origin, BISTRO.rpID);
    expect((await enrolVerify(ctx(BISTRO, loginCookie), token, resp)).status).toBe(400);
    expect(await count("passkeys")).toBe(0);
  });

  it("a response made for another origin or RP ID is refused", async () => {
    const token = await invite();
    const opt = await enrolOptions(ctx(), token);
    const cookie = cookieValue(opt.cookies[0]);
    const wrongOrigin = await new SoftAuthenticator().register(opt.body.options as never, "https://evil.example", BISTRO.rpID);
    expect((await enrolVerify(ctx(BISTRO, cookie), token, wrongOrigin)).status).toBe(400);
    const wrongRp = await new SoftAuthenticator().register(opt.body.options as never, BISTRO.origin, "evil.example");
    expect((await enrolVerify(ctx(BISTRO, cookie), token, wrongRp)).status).toBe(400);
    expect(await count("passkeys")).toBe(0);
  });

  it("a re-invited owner's existing passkeys are listed in excludeCredentials", async () => {
    const { auth } = await enrol();
    const again = await invite();
    const opt = await enrolOptions(ctx(), again);
    const excluded = (opt.body.options as { excludeCredentials: { id: string }[] }).excludeCredentials.map((c) => c.id);
    expect(excluded).toEqual([auth.id]);
  });
});

describe("per-site isolation (answer 7)", () => {
  it("a bistro invite does not enrol on the westafrican Worker", async () => {
    const token = await invite("bistro");
    expect((await enrolOptions(ctx(WEST), token)).status).toBe(410);
    expect((await enrolVerify(ctx(WEST, "x.1.y"), token, {})).status).toBe(410);
  });

  it("a bistro passkey does not sign in to westafrican, with its own RP ID or a shared one", async () => {
    const { auth } = await enrol(BISTRO);
    // Same email is even a westafrican member: it must still be refused (passkeys are per site).
    await invite("westafrican", "owner@bistro.se");
    expect((await login(auth, WEST)).result.status).toBe(401);
    // Both sites on one host name (e.g. localhost on two ports): the site pin still refuses it.
    const sharedHost = { ...WEST, origin: BISTRO.origin, rpID: BISTRO.rpID };
    expect((await login(auth, sharedHost)).result.status).toBe(401);
    expect(await count("sessions")).toBe(1); // only the enrolment's own session
  });

  it("a bistro session is not a westafrican session", async () => {
    const { session } = await enrol(BISTRO);
    await invite("westafrican", "owner@bistro.se");
    expect(await getSession(db, "westafrican", session, now)).toBeNull();
  });
});

describe("sign-in", () => {
  it("a revoked owner's passkey is refused", async () => {
    const { auth } = await enrol();
    await db.batch(prepare(db, revokeStatements("bistro", "owner@bistro.se")));
    expect((await login(auth)).result.status).toBe(401);
  });

  it("a sign counter that goes backwards is refused and stores no session", async () => {
    const { auth } = await enrol(BISTRO, "owner@bistro.se", new SoftAuthenticator(5));
    expect((await login(auth, BISTRO, { counter: 10 })).result.status).toBe(200);
    const before = await count("sessions");
    expect((await login(auth, BISTRO, { counter: 7 })).result.status).toBe(401);
    expect((await login(auth, BISTRO, { counter: 10 })).result.status).toBe(401);
    expect(await count("sessions")).toBe(before);
  });

  it("the stored counter follows the authenticator", async () => {
    const { auth } = await enrol(BISTRO, "owner@bistro.se", new SoftAuthenticator(5));
    await login(auth, BISTRO, { counter: 42 });
    expect(await db.prepare("SELECT counter FROM passkeys").first<number>("counter")).toBe(42);
  });

  it("an expired sign-in challenge is refused", async () => {
    const { auth } = await enrol();
    const options = await loginOptions(ctx());
    const challenge = (options.body.options as { challenge: string }).challenge;
    const response = await auth.assert(challenge, BISTRO.origin, BISTRO.rpID);
    const late = new Date(now.getTime() + 5 * 60_000 + 1000);
    expect((await loginVerify(ctx(BISTRO, cookieValue(options.cookies[0]), late), response)).status).toBe(400);
  });

  it("an assertion whose userHandle names a different user is refused (WebAuthn §7.2 step 6)", async () => {
    const { auth } = await enrol();
    await invite("bistro", "chef@bistro.se");
    const otherId = (await db.prepare("SELECT id FROM users WHERE email = 'chef@bistro.se'").first<string>("id"))!;
    const { result } = await login(auth, BISTRO, { userHandle: base64url(enc.encode(otherId)) });
    expect(result.status).toBe(401);
  });

  it("a captured assertion can't be replayed with its challenge cookie (counter-less passkeys, e.g. iCloud)", async () => {
    const { auth } = await enrol(); // counter stays 0, as synced passkeys do
    const { result, cookie, response } = await login(auth);
    expect(result.status).toBe(200);
    const replay = await loginVerify(ctx(BISTRO, cookie), response);
    expect(replay.status).not.toBe(200);
  });
});

describe("adding a device", () => {
  it("registering the same credential twice answers with a refusal, not an exception", async () => {
    const { auth, session } = await enrol();
    const s = (await getSession(db, "bistro", session, now))!;
    const opt = await confirmedAddOptions((c) => ctx(BISTRO, c), s, BISTRO.origin, BISTRO.rpID);
    // A client that ignores excludeCredentials and re-registers the same credential id.
    const resp = await auth.register(opt.body.options as never, BISTRO.origin, BISTRO.rpID);
    const result = await addPasskeyVerify(ctx(BISTRO, cookieValue(opt.cookies[0])), s, resp).catch((e: Error) => ({ status: 500, error: e.message }));
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  it("an add-device challenge is bound to the session that asked for it", async () => {
    const { session } = await enrol();
    const s = (await getSession(db, "bistro", session, now))!;
    const opt = await confirmedAddOptions((c) => ctx(BISTRO, c), s, BISTRO.origin, BISTRO.rpID);
    const other = { ...s, tokenHash: await sha256Hex("someone else's session") };
    const resp = await new SoftAuthenticator().register(opt.body.options as never, BISTRO.origin, BISTRO.rpID);
    expect((await addPasskeyVerify(ctx(BISTRO, cookieValue(opt.cookies[0])), other, resp)).status).toBe(400);
    expect(await count("passkeys")).toBe(1);
  });
});
