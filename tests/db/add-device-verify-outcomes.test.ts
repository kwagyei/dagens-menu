/**
 * Review L3, 18 Oct (tester, 19 Oct): every refusal of addPasskeyVerify names its cause, and
 * none of them writes a passkey, an audit row or a used challenge. Expired vs missing vs
 * forged/cross-purpose cookie, a bad response, a duplicate credential, a replayed challenge,
 * and a duplicate credential that is also a replay.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueInvite } from "../../src/auth/invites";
import { addPasskeyOptions, addPasskeyVerify, type CeremonyContext, enrolOptions, enrolVerify } from "../../src/auth/passkeys";
import { getSession, type Session } from "../../src/auth/sessions";
import { prepare } from "../../src/db/sql";
import { confirmedAddOptions, cookieValue } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const now = new Date("2026-10-18T10:00:00Z");
const origin = "https://bistro.example";
const rpID = "bistro.example";

const ctx = (challengeCookie?: string, at = now, site: "bistro" | "westafrican" = "bistro"): CeremonyContext => ({
  db,
  site,
  siteName: site,
  secret: "c".repeat(32),
  origin: site === "bistro" ? origin : "https://westafrican.example",
  rpID: site === "bistro" ? rpID : "westafrican.example",
  now: at,
  challengeCookie,
});
const n = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<number>("n"))!;
const counts = async () => ({
  passkeys: await n("SELECT count(*) AS n FROM passkeys"),
  added: await n("SELECT count(*) AS n FROM audit_log WHERE entity = 'passkey' AND action = 'create'"),
  used: await n("SELECT count(*) AS n FROM used_challenges"),
});

async function enrolled(email: string, site: "bistro" | "westafrican" = "bistro", auth = new SoftAuthenticator()): Promise<{ session: Session; auth: SoftAuthenticator }> {
  const issued = await issueInvite(site, email, now);
  await db.batch(prepare(db, issued.statements));
  const c = ctx(undefined, now, site);
  const options = await enrolOptions(c, issued.token);
  const response = await auth.register(options.body.options as never, c.origin, c.rpID);
  const result = await enrolVerify(ctx(cookieValue(options.cookies[0]), now, site), issued.token, response);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const token = cookieValue(result.cookies.find((x) => x.startsWith("__Host-dm_admin="))!);
  return { session: (await getSession(db, site, token, now))!, auth };
}

/** Steps 1 and 2 done: the registration options and their challenge cookie. */
async function confirmed(session: Session) {
  const result = await confirmedAddOptions((c) => ctx(c), session, origin, rpID);
  return { options: result.body.options as { challenge: string; user: { id: string } }, cookie: cookieValue(result.cookies[0]) };
}

/** A refusal: the status and error, the challenge cookie cleared, and nothing written. */
async function expectRefused(result: Awaited<ReturnType<typeof addPasskeyVerify>>, before: Awaited<ReturnType<typeof counts>>, status: number, error: string) {
  expect(result).toMatchObject({ status, body: { error } });
  expect(result.cookies.some((c) => /Max-Age=0/.test(c))).toBe(true);
  expect(await counts()).toEqual(before);
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM used_challenges"),
    db.prepare("DELETE FROM audit_log"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')"),
  ]);
});

describe("challenge-expired: no usable confirmation cookie", () => {
  it("missing cookie", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options } = await confirmed(session);
    const device = await new SoftAuthenticator().register(options, origin, rpID);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(), session, device), before, 400, "challenge-expired");
  });

  it("expired cookie (6 minutes later), also with a garbage response", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const device = await new SoftAuthenticator().register(options, origin, rpID);
    const late = new Date(now.getTime() + 6 * 60 * 1000);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookie, late), session, device), before, 400, "challenge-expired");
    await expectRefused(await addPasskeyVerify(ctx(cookie, late), session, { nonsense: true }), before, 400, "challenge-expired");
  });

  it("a tampered cookie", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const device = await new SoftAuthenticator().register(options, origin, rpID);
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(tampered), session, device), before, 400, "challenge-expired");
  });

  it("the step-1 (add-confirm) cookie in place of the step-2 cookie", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const first = await addPasskeyOptions(ctx(), session);
    const challenge = (first.body.confirm as { challenge: string }).challenge;
    const device = await new SoftAuthenticator().register({ challenge, user: { id: "x" } }, origin, rpID);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookieValue(first.cookies[0])), session, device), before, 400, "challenge-expired");
  });

  it("another session's confirmation cookie (same person, other device)", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { session: other } = await enrolled("chef@bistro.se");
    const { options, cookie } = await confirmed(other);
    const device = await new SoftAuthenticator().register(options, origin, rpID);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, device), before, 400, "challenge-expired");
  });
});

describe("verification-failed: a good cookie, a bad response", () => {
  it.each([
    ["no response", undefined],
    ["an empty object", {}],
    ["a string", "hello"],
  ])("%s", async (_, response) => {
    const { session } = await enrolled("owner@bistro.se");
    const { cookie } = await confirmed(session);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, response), before, 400, "verification-failed");
  });

  it("a passkey made for another challenge, origin or rpID", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const before = await counts();
    const otherChallenge = await new SoftAuthenticator().register({ ...options, challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, origin, rpID);
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, otherChallenge), before, 400, "verification-failed");
    const otherOrigin = await new SoftAuthenticator().register(options, "https://evil.example", rpID);
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, otherOrigin), before, 400, "verification-failed");
    const otherRp = await new SoftAuthenticator().register(options, origin, "evil.example");
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, otherRp), before, 400, "verification-failed");
  });

  it("a passkey without user verification", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const key = new SoftAuthenticator();
    key.verified = false;
    const device = await key.register(options, origin, rpID);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, device), before, 400, "verification-failed");
  });
});

describe("already-registered: the credential is stored", () => {
  it("the person's own signed-in passkey, offered again on a fresh confirmation", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const again = await auth.register(options, origin, rpID);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, again), before, 409, "already-registered");
  });

  it("a credential id that belongs to someone else on another site", async () => {
    const shared = new SoftAuthenticator();
    await enrolled("guest@westafrican.se", "westafrican", shared);
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const device = await shared.register(options, origin, rpID);
    const before = await counts();
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, device), before, 409, "already-registered");
  });
});

describe("challenge-used: the confirmation was redeemed already", () => {
  it("a second, new passkey against a redeemed challenge", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    expect((await addPasskeyVerify(ctx(cookie), session, await new SoftAuthenticator().register(options, origin, rpID))).status).toBe(200);
    const before = await counts();
    const second = await new SoftAuthenticator().register(options, origin, rpID);
    await expectRefused(await addPasskeyVerify(ctx(cookie), session, second), before, 401, "challenge-used");
  });

  it("the same passkey replayed (duplicate AND replay) gets a 4xx refusal and writes nothing", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const device = await new SoftAuthenticator().register(options, origin, rpID);
    expect((await addPasskeyVerify(ctx(cookie), session, device)).status).toBe(200);
    const before = await counts();
    const replay = await addPasskeyVerify(ctx(cookie), session, device);
    // The credential check runs first, so the answer is already-registered; both are true and
    // either sends the page back to step one. Pinned so a change of order is a decision.
    await expectRefused(replay, before, 409, "already-registered");
  });

  it("two different new passkeys sent at once against one challenge: one is stored, one challenge-used", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const a = await new SoftAuthenticator().register(options, origin, rpID);
    const b = await new SoftAuthenticator().register(options, origin, rpID);
    const results = await Promise.all([addPasskeyVerify(ctx(cookie), session, a), addPasskeyVerify(ctx(cookie), session, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(results.find((r) => r.status === 401)?.body).toEqual({ error: "challenge-used" });
    expect(await n("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toBe(2);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE entity = 'passkey' AND action = 'create'")).toBe(1);
  });
});

describe("success", () => {
  it("writes exactly one passkey, one audit row and one used challenge, and clears the cookie", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    const before = await counts();
    const result = await addPasskeyVerify(ctx(cookie), session, await new SoftAuthenticator().register(options, origin, rpID));
    expect(result).toMatchObject({ status: 200, body: { ok: true } });
    expect(result.cookies.some((c) => /Max-Age=0/.test(c))).toBe(true);
    expect(await counts()).toEqual({ passkeys: before.passkeys + 1, added: before.added + 1, used: before.used + 1 });
  });
});

describe("what a refusal leaves behind (observation)", () => {
  it("a 409 or 400 refusal does not burn the challenge: the same cookie still adds a different passkey", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { options, cookie } = await confirmed(session);
    expect((await addPasskeyVerify(ctx(cookie), session, await auth.register(options, origin, rpID))).status).toBe(409);
    expect((await addPasskeyVerify(ctx(cookie), session, {})).status).toBe(400);
    // The refusal clears the cookie in the browser, but the signed value stays valid server-side
    // for its 5 minutes. Unchanged from before L3; recorded so it's a known property.
    expect((await addPasskeyVerify(ctx(cookie), session, await new SoftAuthenticator().register(options, origin, rpID))).status).toBe(200);
  });
});
