/**
 * Security review M2, 18 Oct: edges of the three-step add-device ceremony that
 * add-device-confirmation.test.ts doesn't cover. Cross-purpose challenge cookies, a forged user
 * handle, a cloned (rolled-back) counter, concurrent confirmations, expiry of the step-1
 * challenge, legacy sessions, and that a failed confirmation burns nothing.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueInvite } from "../../src/auth/invites";
import { addPasskeyConfirm, addPasskeyOptions, addPasskeyVerify, type CeremonyContext, enrolOptions, enrolVerify, loginOptions, removePasskey } from "../../src/auth/passkeys";
import { getSession, type Session } from "../../src/auth/sessions";
import { prepare } from "../../src/db/sql";
import { cookieValue } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const now = new Date("2026-10-18T10:00:00Z");
const origin = "https://bistro.example";
const rpID = "bistro.example";

const ctx = (challengeCookie?: string, at = now): CeremonyContext => ({
  db,
  site: "bistro",
  siteName: "bistro",
  secret: "c".repeat(32),
  origin,
  rpID,
  now: at,
  challengeCookie,
});
const one = async <T>(sql: string, ...params: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...params)
    .first<T>())!;

async function enrolled(email: string): Promise<{ session: Session; auth: SoftAuthenticator }> {
  const issued = await issueInvite("bistro", email, now);
  await db.batch(prepare(db, issued.statements));
  const auth = new SoftAuthenticator();
  const options = await enrolOptions(ctx(), issued.token);
  const response = await auth.register(options.body.options as never, origin, rpID);
  const result = await enrolVerify(ctx(cookieValue(options.cookies[0])), issued.token, response);
  const token = cookieValue(result.cookies.find((c) => c.startsWith("__Host-dm_admin="))!);
  return { session: (await getSession(db, "bistro", token, now))!, auth };
}

async function step1(session: Session) {
  const first = await addPasskeyOptions(ctx(), session);
  return { challenge: (first.body.confirm as { challenge: string }).challenge, cookie: cookieValue(first.cookies[0]) };
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM used_challenges"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')"),
  ]);
});

describe("no other challenge cookie stands in for the confirmation", () => {
  it("a sign-in challenge cookie can't confirm", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const login = await loginOptions(ctx());
    const challenge = (login.body.options as { challenge: string }).challenge;
    const result = await addPasskeyConfirm(ctx(cookieValue(login.cookies[0])), session, await auth.assert(challenge, origin, rpID));
    expect(result).toMatchObject({ status: 400, body: { error: "challenge-expired" } });
  });

  it("a sign-in or enrolment challenge cookie can't register a new device", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const login = await loginOptions(ctx());
    const challenge = (login.body.options as { challenge: string }).challenge;
    const device = await new SoftAuthenticator().register({ challenge, user: { id: "x" } }, origin, rpID);
    expect((await addPasskeyVerify(ctx(cookieValue(login.cookies[0])), session, device)).status).toBe(400);

    const issued = await issueInvite("bistro", "chef@bistro.se", now);
    await db.batch(prepare(db, issued.statements));
    const enrol = await enrolOptions(ctx(), issued.token);
    const device2 = await new SoftAuthenticator().register(enrol.body.options as never, origin, rpID);
    expect((await addPasskeyVerify(ctx(cookieValue(enrol.cookies[0])), session, device2)).status).toBe(400);
    expect(await one<{ n: number }>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toEqual({ n: 1 });
  });

  it("the step-1 cookie expires after 5 minutes", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { challenge, cookie } = await step1(session);
    const late = new Date(now.getTime() + 5 * 60 * 1000 + 1000);
    const result = await addPasskeyConfirm(ctx(cookie, late), session, await auth.assert(challenge, origin, rpID));
    expect(result).toMatchObject({ status: 400, body: { error: "challenge-expired" } });
  });

  it("a confirmation by the owner's own passkey under a forged user handle is refused", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { session: colleague } = await enrolled("chef@bistro.se");
    const { challenge, cookie } = await step1(session);
    const forged = await auth.assert(challenge, origin, rpID, { userHandle: Buffer.from(colleague.userId).toString("base64url") });
    expect((await addPasskeyConfirm(ctx(cookie), session, forged)).status).toBe(401);
  });
});

describe("the confirmation's writes", () => {
  it("a rolled-back counter (a cloned authenticator) is refused, and nothing is written", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    await db.prepare("UPDATE passkeys SET counter = 50 WHERE id = ?").bind(auth.id).run();
    const { challenge, cookie } = await step1(session);
    const result = await addPasskeyConfirm(ctx(cookie), session, await auth.assert(challenge, origin, rpID, { counter: 10 }));
    expect(result.status).toBe(401);
    expect(await one<{ counter: number }>("SELECT counter FROM passkeys WHERE id = ?", auth.id)).toEqual({ counter: 50 });
    expect(await one<{ n: number }>("SELECT count(*) AS n FROM used_challenges")).toEqual({ n: 0 });
  });

  it("a good confirmation moves the counter forward and records last use, with the challenge", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    await db.prepare("UPDATE passkeys SET counter = 5 WHERE id = ?").bind(auth.id).run();
    const { challenge, cookie } = await step1(session);
    const result = await addPasskeyConfirm(ctx(cookie), session, await auth.assert(challenge, origin, rpID, { counter: 9 }));
    expect(result.status).toBe(200);
    expect(await one("SELECT counter, last_used_at FROM passkeys WHERE id = ?", auth.id)).toEqual({ counter: 9, last_used_at: "2026-10-18T10:00:00Z" });
    expect(await one<{ n: number }>("SELECT count(*) AS n FROM used_challenges WHERE challenge = ?", challenge)).toEqual({ n: 1 });
  });

  it("the same signature sent twice at once confirms only once", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { challenge, cookie } = await step1(session);
    const assertion = await auth.assert(challenge, origin, rpID);
    const results = await Promise.all([addPasskeyConfirm(ctx(cookie), session, assertion), addPasskeyConfirm(ctx(cookie), session, assertion)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("registration options from one confirmation add one device, not two", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { challenge, cookie } = await step1(session);
    const confirmed = await addPasskeyConfirm(ctx(cookie), session, await auth.assert(challenge, origin, rpID));
    const addCookie = cookieValue(confirmed.cookies[0]);
    const a = await new SoftAuthenticator().register(confirmed.body.options as never, origin, rpID);
    const b = await new SoftAuthenticator().register(confirmed.body.options as never, origin, rpID);
    expect((await addPasskeyVerify(ctx(addCookie), session, a)).status).toBe(200);
    expect(await addPasskeyVerify(ctx(addCookie), session, b)).toMatchObject({ status: 401, body: { error: "challenge-used" } });
    expect(await one<{ n: number }>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toEqual({ n: 2 });
  });

  it("the registration options exclude the person's existing passkeys", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { challenge, cookie } = await step1(session);
    const confirmed = await addPasskeyConfirm(ctx(cookie), session, await auth.assert(challenge, origin, rpID));
    expect((confirmed.body.options as { excludeCredentials: Array<{ id: string }> }).excludeCredentials.map((c) => c.id)).toEqual([auth.id]);
  });
});

describe("legacy sessions and the other device journeys", () => {
  it("a legacy session (no passkey recorded) adds a device only after its owner's passkey confirms", async () => {
    const { session: real, auth } = await enrolled("owner@bistro.se");
    const legacy: Session = { ...real, passkeyId: null as never };
    const first = await addPasskeyOptions(ctx(), legacy);
    const confirm = first.body.confirm as { challenge: string; allowCredentials: Array<{ id: string }> };
    expect(confirm.allowCredentials.map((c) => c.id)).toEqual([auth.id]);
    const stranger = new SoftAuthenticator();
    await stranger.register({ challenge: confirm.challenge, user: { id: Buffer.from(real.userId).toString("base64url") } }, origin, rpID);
    expect((await addPasskeyConfirm(ctx(cookieValue(first.cookies[0])), legacy, await stranger.assert(confirm.challenge, origin, rpID))).status).toBe(401);
    const ok = await addPasskeyConfirm(ctx(cookieValue(first.cookies[0])), legacy, await auth.assert(confirm.challenge, origin, rpID));
    expect(ok.status).toBe(200);
  });

  it("a device added this way can sign in, and the first can then be removed", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { challenge, cookie } = await step1(session);
    const confirmed = await addPasskeyConfirm(ctx(cookie), session, await auth.assert(challenge, origin, rpID));
    const device = new SoftAuthenticator();
    const response = await device.register(confirmed.body.options as never, origin, rpID);
    expect((await addPasskeyVerify(ctx(cookieValue(confirmed.cookies[0])), session, response)).status).toBe(200);
    expect(await removePasskey(db, session, auth.id, now)).toBe("signed-out");
    expect(await one<{ n: number }>("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toEqual({ n: 1 });
  });
});
