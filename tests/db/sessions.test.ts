/** Plan M4.3: sessions are hashed, site-pinned, expire (30 days absolute, 14 idle) and end on revoke. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issueInvite, revokeStatements } from "../../src/auth/invites";
import {
  clearSessionCookie,
  endAllSessionsStatement,
  getSession,
  newSession,
  readCookie,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  sessionCookie,
} from "../../src/auth/sessions";
import { prepare, stmt } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-16T10:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const HOUR = 3_600_000;
let userId: string;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')")]);
  await db.batch(prepare(db, (await issueInvite("bistro", "owner@bistro.se", now)).statements));
  userId = (await db.prepare("SELECT id FROM users").first<string>("id"))!;
});

/** A session made with a stand-in passkey (sessions record the passkey they were made with). */
async function signIn(site = "bistro", when = now) {
  const s = await newSession(userId, site, "test-passkey", when);
  await db.batch(
    prepare(db, [stmt("INSERT INTO passkeys (id, user_id, site_id, public_key) VALUES ('test-passkey', ?, ?, x'00') ON CONFLICT DO NOTHING", userId, site), s.statement]),
  );
  return s.token;
}

describe("getSession", () => {
  it("returns the signed-in owner for their site", async () => {
    const token = await signIn();
    expect(await getSession(db, "bistro", token, now)).toMatchObject({ userId, email: "owner@bistro.se", role: "owner", siteId: "bistro" });
  });

  it("stores only the token's hash", async () => {
    const token = await signIn();
    expect(JSON.stringify((await db.prepare("SELECT * FROM sessions").all()).results)).not.toContain(token);
  });

  it("doesn't work on another site, even for the same person", async () => {
    const token = await signIn();
    expect(await getSession(db, "westafrican", token, now)).toBeNull();
  });

  it("ends 30 days after sign-in however active it is", async () => {
    const token = await signIn();
    for (let day = 1; day < 30; day++) expect(await getSession(db, "bistro", token, at(day * 24 * HOUR))).not.toBeNull();
    expect(await getSession(db, "bistro", token, at(SESSION_ABSOLUTE_MS))).toBeNull();
  });

  it("ends after 14 days without use", async () => {
    const token = await signIn();
    expect(await getSession(db, "bistro", token, at(SESSION_IDLE_MS - HOUR))).not.toBeNull();
    // That visit counted as use: the idle clock restarted.
    expect(await getSession(db, "bistro", token, at(SESSION_IDLE_MS + HOUR))).not.toBeNull();
    expect(await getSession(db, "bistro", token, at(2 * SESSION_IDLE_MS + HOUR))).toBeNull();
  });

  it("writes last_seen_at at most once an hour", async () => {
    const token = await signIn();
    const lastSeen = () => db.prepare("SELECT last_seen_at FROM sessions").first<string>("last_seen_at");
    await getSession(db, "bistro", token, at(30 * 60_000));
    expect(await lastSeen()).toBe("2026-10-16T10:00:00Z");
    await getSession(db, "bistro", token, at(HOUR));
    expect(await lastSeen()).toBe("2026-10-16T11:00:00Z");
  });

  it("ends the moment the membership is revoked", async () => {
    const token = await signIn();
    await db.batch(prepare(db, revokeStatements("bistro", "owner@bistro.se")));
    expect(await getSession(db, "bistro", token, now)).toBeNull();
  });

  it("can be ended everywhere at once", async () => {
    const a = await signIn();
    const b = await signIn();
    await db.batch(prepare(db, [endAllSessionsStatement(userId, "bistro")]));
    expect([await getSession(db, "bistro", a, now), await getSession(db, "bistro", b, now)]).toEqual([null, null]);
  });

  it("rejects missing, malformed and unknown tokens", async () => {
    await signIn();
    for (const token of [undefined, "", "abc", "x".repeat(43), "'; DROP TABLE sessions; --"]) {
      expect(await getSession(db, "bistro", token, now)).toBeNull();
    }
  });
});

describe("cookies", () => {
  it("sets a __Host- cookie that scripts and other sites can't read", () => {
    const cookie = sessionCookie("tok", at(SESSION_ABSOLUTE_MS));
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=tok; Path=/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$`));
    expect(cookie).not.toMatch(/Domain=/i);
    expect(clearSessionCookie).toMatch(/Max-Age=0/);
  });

  it("reads a cookie out of a header", () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=tok; b=2`, SESSION_COOKIE)).toBe("tok");
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE)).toBeUndefined();
  });
});
