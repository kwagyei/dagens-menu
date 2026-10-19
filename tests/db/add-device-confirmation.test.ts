/**
 * Security review M2 (18 Oct): a session alone can't add a passkey. Adding a device first
 * takes a fresh signature from one of the signed-in person's own passkeys on this site; only
 * then does the server issue registration options, valid for 5 minutes.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueInvite } from "../../src/auth/invites";
import { addPasskeyConfirm, addPasskeyOptions, addPasskeyVerify, type CeremonyContext, enrolOptions, enrolVerify } from "../../src/auth/passkeys";
import { getSession, type Session } from "../../src/auth/sessions";
import { prepare } from "../../src/db/sql";
import { cookieValue } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const now = new Date("2026-10-18T10:00:00Z");
const SITES = {
  bistro: { origin: "https://bistro.example", rpID: "bistro.example" },
  westafrican: { origin: "https://westafrican.example", rpID: "westafrican.example" },
} as const;
type SiteId = keyof typeof SITES;

const ctx = (site: SiteId = "bistro", challengeCookie?: string, at = now): CeremonyContext => ({
  db,
  site,
  siteName: site,
  secret: "c".repeat(32),
  origin: SITES[site].origin,
  rpID: SITES[site].rpID,
  now: at,
  challengeCookie,
});
const count = async (sql: string, ...params: unknown[]) =>
  (await db
    .prepare(sql)
    .bind(...params)
    .first<number>("n"))!;

/** A person enrolled on `site` with their own software passkey; their session and authenticator. */
async function enrolled(email: string, site: SiteId = "bistro"): Promise<{ session: Session; auth: SoftAuthenticator }> {
  const issued = await issueInvite(site, email, now);
  await db.batch(prepare(db, issued.statements));
  const auth = new SoftAuthenticator();
  const options = await enrolOptions(ctx(site), issued.token);
  const response = await auth.register(options.body.options as never, SITES[site].origin, SITES[site].rpID);
  const result = await enrolVerify(ctx(site, cookieValue(options.cookies[0])), issued.token, response);
  const token = cookieValue(result.cookies.find((c) => c.startsWith("__Host-dm_admin="))!);
  return { session: (await getSession(db, site, token, now))!, auth };
}

/** Step 1, then a signature over its challenge by `signer`. */
async function confirmWith(session: Session, signer: SoftAuthenticator, site: SiteId = "bistro", sign: { rpID?: string; origin?: string } = {}) {
  const first = await addPasskeyOptions(ctx(site), session);
  const { challenge } = first.body.confirm as { challenge: string };
  const assertion = await signer.assert(challenge, sign.origin ?? SITES[site].origin, sign.rpID ?? SITES[site].rpID);
  const cookie = cookieValue(first.cookies[0]);
  return { cookie, assertion, result: await addPasskeyConfirm(ctx(site, cookie), session, assertion) };
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')")]);
});

describe("step 1 asks for a confirmation, not a new passkey", () => {
  it("returns sign-in options for the person's own passkeys and no registration options", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const first = await addPasskeyOptions(ctx(), session);
    expect(first.body.options).toBeUndefined();
    const confirm = first.body.confirm as { userVerification: string; allowCredentials: Array<{ id: string }> };
    expect(confirm.userVerification).toBe("required");
    expect(confirm.allowCredentials.map((c) => c.id)).toEqual([auth.id]);
  });

  it("a new passkey sent against the step-1 challenge is refused: the confirmation can't be skipped", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const first = await addPasskeyOptions(ctx(), session);
    const { challenge } = first.body.confirm as { challenge: string };
    const attacker = await new SoftAuthenticator().register({ challenge, user: { id: "x" } }, SITES.bistro.origin, SITES.bistro.rpID);
    expect((await addPasskeyVerify(ctx("bistro", cookieValue(first.cookies[0])), session, attacker)).status).toBe(400);
    expect(await count("SELECT count(*) AS n FROM passkeys")).toBe(1);
  });
});

describe("step 2 accepts only a fresh signature by the person's own passkey", () => {
  it("the signed-in passkey confirms, and the registration options follow", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { result } = await confirmWith(session, auth);
    expect(result.status).toBe(200);
    expect((result.body.options as { authenticatorSelection: { userVerification: string } }).authenticatorSelection.userVerification).toBe("required");
  });

  it("refuses another person's passkey on the same site", async () => {
    const { session } = await enrolled("owner@bistro.se");
    const { auth: colleague } = await enrolled("chef@bistro.se");
    const { result } = await confirmWith(session, colleague);
    expect(result).toMatchObject({ status: 401, body: { error: "unknown-passkey" } });
  });

  it("refuses the same person's passkey from the other site", async () => {
    const { session } = await enrolled("owner@both.se");
    const { auth: theirs } = await enrolled("owner@both.se", "westafrican");
    const { result } = await confirmWith(session, theirs, "bistro", { rpID: SITES.westafrican.rpID, origin: SITES.westafrican.origin });
    expect(result.status).toBe(401);
  });

  it("refuses a signature without user verification", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    auth.verified = false;
    const { result } = await confirmWith(session, auth);
    expect(result).toMatchObject({ status: 401, body: { error: "verification-failed" } });
  });

  it("refuses a signature made for another site's origin", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { result } = await confirmWith(session, auth, "bistro", { origin: "https://evil.example" });
    expect(result.status).toBe(401);
  });

  it("refuses a step-1 challenge from another session", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { session: other } = await enrolled("chef@bistro.se");
    const first = await addPasskeyOptions(ctx(), other);
    const { challenge } = first.body.confirm as { challenge: string };
    const result = await addPasskeyConfirm(ctx("bistro", cookieValue(first.cookies[0])), session, await auth.assert(challenge, SITES.bistro.origin, SITES.bistro.rpID));
    expect(result).toMatchObject({ status: 400, body: { error: "challenge-expired" } });
  });

  it("a confirmation can't be replayed", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { cookie, assertion, result } = await confirmWith(session, auth);
    expect(result.status).toBe(200);
    expect((await addPasskeyConfirm(ctx("bistro", cookie), session, assertion)).status).toBe(401);
  });
});

describe("step 3: the confirmation is fresh", () => {
  it("adds the new passkey within 5 minutes of the confirmation", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { result } = await confirmWith(session, auth);
    const device = await new SoftAuthenticator().register(result.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const at = new Date(now.getTime() + 4 * 60 * 1000);
    expect((await addPasskeyVerify(ctx("bistro", cookieValue(result.cookies[0]), at), session, device)).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toBe(2);
  });

  it("refuses the new passkey after 5 minutes: confirm again", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { result } = await confirmWith(session, auth);
    const device = await new SoftAuthenticator().register(result.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const late = new Date(now.getTime() + 6 * 60 * 1000);
    expect(await addPasskeyVerify(ctx("bistro", cookieValue(result.cookies[0]), late), session, device)).toMatchObject({ status: 400, body: { error: "challenge-expired" } });
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toBe(1);
  });

  it("names a missing confirmation cookie as expired, not as a failed verification (review L3)", async () => {
    const { session, auth } = await enrolled("owner@bistro.se");
    const { result } = await confirmWith(session, auth);
    const device = await new SoftAuthenticator().register(result.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    expect(await addPasskeyVerify(ctx("bistro"), session, device)).toMatchObject({ status: 400, body: { error: "challenge-expired" } });
  });
});
