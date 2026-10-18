/**
 * (ADR-016.2, AC 1/7/8): hostile cases for the operator purge. A row is
 * purged iff the app refuses it; nothing is deleted on a failed batch; the rendered SQL the
 * CLI sends matches the bound statements; other sites are untouched.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/crypto";
import { findInvite } from "../../src/auth/invites";
import { type PurgeCounts, purgeCountStatement, purgeStatements } from "../../src/auth/purge";
import { getSession, SESSION_IDLE_MS } from "../../src/auth/sessions";
import { isoSeconds } from "../../src/db/repository";
import { prepare, renderSql, stmt } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-18T12:00:00Z");
const S = 1000;
const DAY = 24 * 60 * 60 * S;
const at = (ms: number) => isoSeconds(new Date(now.getTime() + ms));
const USER = "owner0000001";
const token = (i: number) => `t${String(i).padStart(42, "0")}`;
const n = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<number>("n"))!;
const purge = (site = "bistro", when = now) => db.batch(prepare(db, purgeStatements(site, when)));

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM rate_limits"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican'), ('begin-commit')"),
    db.prepare("INSERT INTO users (id, email) VALUES (?, 'owner@bistro.se')").bind(USER),
    db.prepare("INSERT INTO memberships (user_id, site_id, role) VALUES (?, 'bistro', 'owner'), (?, 'westafrican', 'owner'), (?, 'begin-commit', 'owner')").bind(USER, USER, USER),
  ]);
});

// Offsets around the two boundaries, to the second, plus a spread over ±2 days.
const OFFSETS = [-2 * DAY, -DAY, -61 * S, -2 * S, -S, 0, S, 2 * S, 61 * S, DAY, 2 * DAY];
const IDLE = [-SESSION_IDLE_MS - S, -SESSION_IDLE_MS, -SESSION_IDLE_MS + S, -SESSION_IDLE_MS + DAY, -S];

describe("purge deletes a session iff getSession refuses it, across the boundaries", () => {
  it("for every expiry × last-seen pair around now and the idle cut-off", async () => {
    const cases: Array<{ tok: string; accepted: boolean }> = [];
    let i = 0;
    for (const e of OFFSETS)
      for (const l of IDLE) {
        // created_at must precede expires_at (CHECK)
        const tok = token(i++);
        await db
          .prepare("INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', ?, ?, ?)")
          .bind(await sha256Hex(tok), USER, at(-40 * DAY), at(l), at(e))
          .run();
      }
    i = 0;
    for (const _e of OFFSETS)
      for (const _l of IDLE) {
        const tok = token(i++);
        // Read with a db snapshot: getSession may touch last_seen_at, which only moves it later
        // and so never turns a refused row into an accepted one.
        cases.push({ tok, accepted: (await getSession(db, "bistro", tok, now)) !== null });
      }
    await purge();
    for (const c of cases) {
      const left = await n("SELECT count(*) AS n FROM sessions WHERE token_hash = ?", await sha256Hex(c.tok));
      expect(left, `${c.tok} accepted=${c.accepted}`).toBe(c.accepted ? 1 : 0);
    }
    expect(cases.some((c) => c.accepted)).toBe(true);
    expect(cases.some((c) => !c.accepted)).toBe(true);
  });
});

describe("purge deletes an invite only when findInvite refuses it, and never a live one", () => {
  it.each(OFFSETS.map((o) => [o]))("expires at now %+d ms, unused", async (offset) => {
    const tok = token(1);
    await db
      .prepare("INSERT INTO invites (token_hash, user_id, site_id, created_at, expires_at) VALUES (?, ?, 'bistro', ?, ?)")
      .bind(await sha256Hex(tok), USER, at(-3 * DAY), at(offset))
      .run();
    const accepted = (await findInvite(db, "bistro", tok, now)) !== null;
    await purge();
    expect(await n("SELECT count(*) AS n FROM invites")).toBe(accepted ? 1 : 0);
  });
});

describe("a failed batch deletes nothing", () => {
  it("rolls back every delete and the note when a later statement fails", async () => {
    await db.batch([
      db.prepare("INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', ?, ?, ?)").bind("a".repeat(64), USER, at(-40 * DAY), at(-20 * DAY), at(-DAY)),
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'menu_item', 'update', 'old')").bind(at(-200 * DAY)),
    ]);
    const statements = purgeStatements("bistro", now);
    // Fail after all deletes have run: a CHECK violation on the last statement.
    const failing = [...statements, stmt("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', 'not-a-date', 'x', 'update', 'x')")];
    await expect(db.batch(prepare(db, failing))).rejects.toThrow();
    expect(await n("SELECT count(*) AS n FROM sessions")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro'")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE summary LIKE 'history older%'")).toBe(0);
  });
});

describe("the SQL the CLI renders", () => {
  it("count and purge statements render with every placeholder bound, and the rendered count equals the bound one", async () => {
    for (const site of ["bistro", "begin-commit"]) {
      const bound = (await prepare(db, [purgeCountStatement(site, now)])[0].first<PurgeCounts>())!;
      const rendered = renderSql([purgeCountStatement(site, now)]).replace(/;$/, "");
      expect(rendered).not.toContain("?");
      const viaText = (await db.prepare(rendered).first<PurgeCounts>())!;
      expect(viaText).toEqual(bound);
      expect(() => renderSql(purgeStatements(site, now))).not.toThrow();
    }
  });

  it("a site id with BEGIN/COMMIT in it (allowed by the CLI's regex) is hex-encoded and still matches only that site", async () => {
    await db.batch([
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('begin-commit', ?, 'menu_item', 'update', 'old')").bind(at(-200 * DAY)),
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'menu_item', 'update', 'old')").bind(at(-200 * DAY)),
    ]);
    const sql = renderSql(purgeStatements("begin-commit", now));
    expect(sql).not.toMatch(/'begin-commit'/);
    // Run the rendered file statement by statement, as one batch, as wrangler would.
    await db.batch(sql.split(/;\n/).map((s) => db.prepare(s.replace(/;$/, ""))));
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro' AND summary = 'old'")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE site_id = 'begin-commit' AND summary = 'old'")).toBe(0);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE site_id = 'begin-commit' AND summary LIKE 'history older than 180 days removed: 1 entry'")).toBe(1);
  });
});

describe("history retention", () => {
  it("keeps a row exactly 180 days old and removes one a second older", async () => {
    await db.batch([
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'menu_item', 'update', 'edge')").bind(at(-180 * DAY)),
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'menu_item', 'update', 'past')").bind(at(-180 * DAY - S)),
    ]);
    await purge();
    const left = (await db.prepare("SELECT summary FROM audit_log ORDER BY id").all<{ summary: string }>()).results.map((r) => r.summary);
    expect(left).toEqual(["edge", "history older than 180 days removed: 1 entry"]);
  });

  it("prunes security records (invites, passkeys, revocations) at 180 days like any other entry", async () => {
    await db.batch([
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'invite', 'create', 'a@b.se: invited as owner; link valid 72 hours')").bind(at(-181 * DAY)),
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'passkey', 'create', 'a@b.se: first passkey created from the invite')").bind(at(-181 * DAY)),
    ]);
    await purge();
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE entity IN ('invite', 'passkey')")).toBe(0);
  });

  it("a later purge, 181 days on, removes the earlier note and counts it", async () => {
    await db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', ?, 'menu_item', 'update', 'old')").bind(at(-200 * DAY)).run();
    await purge();
    await purge("bistro", new Date(now.getTime() + 181 * DAY));
    const left = (await db.prepare("SELECT summary FROM audit_log").all<{ summary: string }>()).results.map((r) => r.summary);
    expect(left).toEqual(["history older than 180 days removed: 1 entry"]);
  });

  it("writes no note for another site and never deletes another site's history, even with an empty site id", async () => {
    await db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('westafrican', ?, 'menu_item', 'update', 'old')").bind(at(-200 * DAY)).run();
    await purge("");
    await purge("%");
    await purge("bistro' OR '1'='1");
    expect(await n("SELECT count(*) AS n FROM audit_log")).toBe(1);
  });
});
