/**
 * The operator's purge (ADR-016.2, acceptance criteria 7 and 8, adapted to the operator-only
 * scope of 2026-10-18): each rule is the exact negation of the check that accepts the row,
 * scoped to one site, and history past 180 days goes with one note saying so.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/crypto";
import { AUDIT_RETENTION_DAYS, type PurgeCounts, purgeCountStatement, purgeStatements } from "../../src/auth/purge";
import { getSession, SESSION_IDLE_MS } from "../../src/auth/sessions";
import { isoSeconds } from "../../src/db/repository";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => isoSeconds(new Date(now.getTime() + ms));
const USER = "owner0000001";

const counts = async (site = "bistro", when = now) => (await prepare(db, [purgeCountStatement(site, when)])[0].first<PurgeCounts>())!;
const purge = (site = "bistro", when = now) => db.batch(prepare(db, purgeStatements(site, when)));
const n = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<number>("n"))!;

/** A session with this token, expiring and last seen at the given offsets from now. */
async function session(token: string, expires: number, lastSeen: number, site = "bistro") {
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), USER, site, at(-20 * DAY), at(lastSeen), at(expires))
    .run();
}
const invite = async (key: string, expires: number, used: boolean, site = "bistro") =>
  db
    .prepare("INSERT INTO invites (token_hash, user_id, site_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(key), USER, site, at(-3 * DAY), at(expires), used ? at(-1 * DAY) : null)
    .run();
const challenge = (key: string, expires: number, site = "bistro") =>
  db.prepare("INSERT INTO used_challenges (challenge, site_id, expires_at) VALUES (?, ?, ?)").bind(key, site, at(expires)).run();
const history = (ageMs: number, summary: string, site = "bistro") =>
  db.prepare("INSERT INTO audit_log (site_id, user_id, at, entity, action, summary) VALUES (?, NULL, ?, 'menu_item', 'update', ?)").bind(site, at(-ageMs), summary).run();

// Tokens getSession can read: 43 base64url characters.
const token = (c: string) => c.repeat(43);

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM rate_limits"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')"),
    db.prepare("INSERT INTO users (id, email) VALUES (?, 'owner@bistro.se')").bind(USER),
    db.prepare("INSERT INTO memberships (user_id, site_id, role) VALUES (?, 'bistro', 'owner'), (?, 'westafrican', 'owner')").bind(USER, USER),
  ]);
});

describe("sessions: purged exactly when getSession refuses them", () => {
  it.each([
    ["expires exactly now", 0, -1000, false],
    ["expires one second from now", 1000, -1000, true],
    ["expired a second ago", -1000, -1000, false],
    ["last seen exactly 14 days ago (idle)", 5 * DAY, -SESSION_IDLE_MS, false],
    ["last seen one second inside the 14 days", 5 * DAY, -SESSION_IDLE_MS + 1000, true],
  ] as const)("%s", async (_name, expires, lastSeen, accepted) => {
    await session(token("a"), expires, lastSeen);
    expect(await getSession(db, "bistro", token("a"), now), "getSession").toEqual(accepted ? expect.anything() : null);
    await purge();
    expect(await n("SELECT count(*) AS n FROM sessions")).toBe(accepted ? 1 : 0);
  });
});

describe("a mixed set (ADR-016 AC 2 and 7)", () => {
  beforeEach(async () => {
    await session(token("e"), -1 * DAY, -2 * DAY); // expired
    await session(token("i"), 10 * DAY, -15 * DAY); // idle-dead, not yet expired
    await session(token("l"), 10 * DAY, -1 * DAY); // live
    await invite("expired unused", -1000, false);
    await invite("expired used", -1000, true);
    await invite("live unused", 2 * DAY, false);
    await challenge("old", -1000);
    await challenge("fresh", 4 * 60 * 1000);
    await session(token("w"), -1 * DAY, -2 * DAY, "westafrican");
    await invite("theirs expired", -1000, false, "westafrican");
  });

  it("counts what would go, and a dry run (counting) changes nothing", async () => {
    expect(await counts()).toEqual({ sessions: 2, invites: 2, used_challenges: 1, audit_log: 0, rate_limits: 0 });
    expect(await n("SELECT count(*) AS n FROM sessions")).toBe(4);
  });

  it("deletes exactly those, keeps the live rows and the other site's, and a second run finds nothing", async () => {
    await purge();
    expect(await getSession(db, "bistro", token("l"), now)).not.toBeNull();
    expect(await n("SELECT count(*) AS n FROM sessions WHERE site_id = 'bistro'")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM invites WHERE site_id = 'bistro'")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM used_challenges")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM sessions WHERE site_id = 'westafrican'")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM invites WHERE site_id = 'westafrican'")).toBe(1);
    expect(await counts()).toEqual({ sessions: 0, invites: 0, used_challenges: 0, audit_log: 0, rate_limits: 0 });
  });

  it("writes no history row for expired auth rows", async () => {
    await purge();
    expect(await n("SELECT count(*) AS n FROM audit_log")).toBe(0);
  });
});

describe(`history older than ${AUDIT_RETENTION_DAYS} days (ADR-016 AC 8)`, () => {
  it("deletes rows at 181 days, keeps 179 days, for this site only, with one note", async () => {
    await history(181 * DAY, "old 1");
    await history(181 * DAY, "old 2");
    await history(179 * DAY, "recent");
    await history(181 * DAY, "theirs", "westafrican");
    expect((await counts()).audit_log).toBe(2);
    await purge();
    const left = (await db.prepare("SELECT summary FROM audit_log WHERE site_id = 'bistro' ORDER BY id").all<{ summary: string }>()).results.map((r) => r.summary);
    expect(left).toEqual(["recent", `history older than ${AUDIT_RETENTION_DAYS} days removed: 2 entries`]);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE site_id = 'westafrican'")).toBe(1);
    // The note is dated now, so the next purge keeps it and writes no second note.
    await purge();
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro'")).toBe(2);
  });

  it("says entry for one", async () => {
    await history(200 * DAY, "only one");
    await purge();
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE summary = ?", `history older than ${AUDIT_RETENTION_DAYS} days removed: 1 entry`)).toBe(1);
  });

  it("writes no note when nothing is old enough", async () => {
    await history(179 * DAY, "recent");
    await purge();
    expect(await n("SELECT count(*) AS n FROM audit_log")).toBe(1);
  });
});

describe("rate_limits (unused today)", () => {
  it("removes windows older than 24 hours, of any key, and keeps newer ones", async () => {
    const seconds = Math.floor(now.getTime() / 1000);
    await db.batch([
      db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('a', ?, 1)").bind(seconds - 25 * 3600),
      db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('b', ?, 1)").bind(seconds - 23 * 3600),
    ]);
    expect((await counts()).rate_limits).toBe(1);
    await purge();
    expect(await n("SELECT count(*) AS n FROM rate_limits")).toBe(1);
  });
});
