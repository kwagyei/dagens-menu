/**
 * Review L9 and L8: a passkey must be verified (Face ID, fingerprint, PIN), not merely present,
 * because it is the only factor; and the invite check that keeps tokens out of URLs reads only.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { findInvite, issueInvite } from "../../src/auth/invites";
import { type CeremonyContext, checkInvite, enrolOptions, enrolVerify, loginOptions, loginVerify } from "../../src/auth/passkeys";
import { prepare } from "../../src/db/sql";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const now = new Date("2026-10-16T10:00:00Z");
const BISTRO = { site: "bistro", origin: "https://bistro.example", rpID: "bistro.example" };

const ctx = (challengeCookie?: string, site = BISTRO.site): CeremonyContext => ({
  db,
  site,
  siteName: site,
  secret: "u".repeat(32),
  origin: BISTRO.origin,
  rpID: BISTRO.rpID,
  now,
  challengeCookie,
});
const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");
const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"))!;

async function invite(site = "bistro") {
  const issued = await issueInvite(site, "owner@bistro.se", now);
  await db.batch(prepare(db, issued.statements));
  return issued.token;
}

async function enrol(auth: SoftAuthenticator, token: string) {
  const options = await enrolOptions(ctx(), token);
  const response = await auth.register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
  return enrolVerify(ctx(cookieValue(options.cookies[0])), token, response);
}

async function login(auth: SoftAuthenticator) {
  const options = await loginOptions(ctx());
  const challenge = (options.body.options as { challenge: string }).challenge;
  const response = await auth.assert(challenge, BISTRO.origin, BISTRO.rpID);
  return loginVerify(ctx(cookieValue(options.cookies[0])), response);
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')")]);
});

describe("user verification is required (review L9)", () => {
  it("asks the device to verify the user when creating and when using a passkey", async () => {
    const enrolling = await enrolOptions(ctx(), await invite());
    expect((enrolling.body.options as { authenticatorSelection: { userVerification: string } }).authenticatorSelection.userVerification).toBe("required");
    const signingIn = await loginOptions(ctx());
    expect((signingIn.body.options as { userVerification: string }).userVerification).toBe("required");
  });

  it("refuses to enrol a passkey that wasn't verified, stores nothing and leaves the invite usable", async () => {
    const token = await invite();
    const result = await enrol(Object.assign(new SoftAuthenticator(), { verified: false }), token);
    expect(result.status).toBe(400);
    expect(await count("passkeys")).toBe(0);
    expect(await count("sessions")).toBe(0);
    expect(await findInvite(db, "bistro", token, now)).not.toBeNull();
    // The same invite then works with a device that does verify.
    expect((await enrol(new SoftAuthenticator(), token)).status).toBe(200);
  });

  it("refuses a sign-in where the device only saw the user present, without a session", async () => {
    const auth = new SoftAuthenticator();
    expect((await enrol(auth, await invite())).status).toBe(200);
    const sessions = await count("sessions");
    auth.verified = false;
    expect((await login(auth)).status).toBe(401);
    expect(await count("sessions")).toBe(sessions);
    auth.verified = true;
    expect((await login(auth)).status).toBe(200);
  });
});

describe("checkInvite (review L8)", () => {
  it("names the invited person for a good token, sets no cookie and writes nothing", async () => {
    const token = await invite();
    const before = await db.prepare("SELECT used_at FROM invites").first();
    const result = await checkInvite(ctx(), token);
    expect(result).toEqual({ status: 200, body: { email: "owner@bistro.se" }, cookies: [] });
    expect(await db.prepare("SELECT used_at FROM invites").first()).toEqual(before);
  });

  it("answers 410 for a used, expired, malformed or other site's token", async () => {
    const token = await invite();
    expect((await enrol(new SoftAuthenticator(), token)).status).toBe(200);
    expect((await checkInvite(ctx(), token)).status).toBe(410);
    const fresh = await invite();
    expect((await checkInvite({ db, site: "bistro", now: new Date(now.getTime() + 73 * 3_600_000) }, fresh)).status).toBe(410);
    expect((await checkInvite(ctx(undefined, "westafrican"), fresh)).status).toBe(410);
    expect((await checkInvite(ctx(), "not a token")).status).toBe(410);
    expect((await checkInvite(ctx(), fresh)).status).toBe(200);
  });
});
