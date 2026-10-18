/**
 * Tester, reviewer M3 and M7 (2026-10-17): edge cases on top of security-events.test.ts.
 * Security events write exactly one audit row, only when they happen, never leaking a token,
 * token hash or credential id; removing a passkey ends exactly the right sessions, on the
 * right site; the migration stays expand-compatible.
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
import en from "../../src/i18n/en";
import sv from "../../src/i18n/sv";
import { SECURITY_EVENTS } from "../../src/auth/audit";
import { confirmedAddOptions } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const SECRET = "t".repeat(32);
const now = new Date("2026-10-17T10:00:00Z");
const SITES = {
  bistro: { site: "bistro", origin: "https://bistro.example", rpID: "bistro.example" },
  westafrican: { site: "westafrican", origin: "https://westafrican.example", rpID: "westafrican.example" },
} as const;
type SiteId = keyof typeof SITES;
const OWNER = "owner@bistro.se";
const CHEF = "chef@bistro.se";

const ctx = (site: SiteId = "bistro", challengeCookie?: string): CeremonyContext => ({
  db,
  site,
  siteName: "Test",
  secret: SECRET,
  origin: SITES[site].origin,
  rpID: SITES[site].rpID,
  now,
  challengeCookie,
});

const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");
const sessionToken = (cookies: string[]) => cookieValue(cookies.find((c) => c.startsWith("__Host-dm_admin="))!);
const session = async (token: string, site: SiteId = "bistro") => (await getSession(db, site, token, now))!;
const alive = async (token: string, site: SiteId = "bistro") => (await getSession(db, site, token, now)) !== null;

interface AuditRow {
  site_id: string;
  user_id: string | null;
  at: string;
  entity: string;
  entity_id: string | null;
  action: string;
  summary: string;
}
const auditRows = async () =>
  (await db.prepare("SELECT site_id, user_id, at, entity, entity_id, action, summary FROM audit_log ORDER BY id").all<AuditRow>()).results;
const userId = async (email = OWNER) => (await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<string>("id"))!;
const version = (site: SiteId = "bistro") => db.prepare("SELECT content_version FROM sites WHERE id = ?").bind(site).first<number>("content_version");
const allSessions = async () => (await db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all<{ token_hash: string }>()).results;

async function invite(email = OWNER, site: SiteId = "bistro") {
  const issued = await issueInvite(site, email, now);
  await db.batch(prepare(db, issued.statements));
  return issued.token;
}

async function enrol(email = OWNER, site: SiteId = "bistro", auth = new SoftAuthenticator()) {
  const token = await invite(email, site);
  const options = await enrolOptions(ctx(site), token);
  const response = await auth.register(options.body.options as never, SITES[site].origin, SITES[site].rpID);
  const result = await enrolVerify(ctx(site, cookieValue(options.cookies[0])), token, response);
  expect(result.status).toBe(200);
  return { auth, token: sessionToken(result.cookies), invite: token };
}

async function login(auth: SoftAuthenticator, site: SiteId = "bistro") {
  const options = await loginOptions(ctx(site));
  const challenge = (options.body.options as { challenge: string }).challenge;
  const result = await loginVerify(ctx(site, cookieValue(options.cookies[0])), await auth.assert(challenge, SITES[site].origin, SITES[site].rpID));
  expect(result.status).toBe(200);
  return sessionToken(result.cookies);
}

async function addDevice(signedIn: Session, auth = new SoftAuthenticator(), site: SiteId = "bistro") {
  const options = await confirmedAddOptions((c) => ctx(site, c), signedIn, SITES[site].origin, SITES[site].rpID);
  const response = await auth.register(options.body.options as never, SITES[site].origin, SITES[site].rpID);
  const result = await addPasskeyVerify(ctx(site, cookieValue(options.cookies[0])), signedIn, response);
  expect(result.status).toBe(200);
  return auth;
}

let legacyCounter = 0;
async function legacySession(email = OWNER, site: SiteId = "bistro") {
  const token = `legacy${legacyCounter++}`.padEnd(43, "q");
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), await userId(email), site, "2026-10-17T09:00:00Z", "2026-10-17T09:00:00Z", "2026-11-16T09:00:00Z")
    .run();
  return token;
}

/** Nothing secret in the audit log: no invite token or its hash, no session token or hash, no credential id. */
async function expectNoSecrets(secrets: string[]) {
  const dump = JSON.stringify(await auditRows());
  for (const s of secrets) {
    expect(dump).not.toContain(s);
    expect(dump).not.toContain(await sha256Hex(s));
  }
  // Also not anywhere the history page reads.
  const history = JSON.stringify(await recentChanges({ db, siteId: "bistro", userId: null, now }));
  for (const s of secrets) expect(history).not.toContain(s);
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')"),
  ]);
});

describe("criterion 1: one audit row per event, only when it happened", () => {
  it("an enrolment with an expired invite writes no audit row and no passkey", async () => {
    const token = await invite();
    const options = await enrolOptions(ctx(), token);
    const response = await new SoftAuthenticator().register(options.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const later = new Date(now.getTime() + 73 * 3600_000);
    const result = await enrolVerify({ ...ctx("bistro", cookieValue(options.cookies[0])), now: later }, token, response);
    expect(result.status).toBe(410);
    expect((await auditRows()).filter((r) => r.action === "update")).toEqual([]);
  });

  it("an enrolment with a bad response (wrong origin) writes no audit row", async () => {
    const token = await invite();
    const options = await enrolOptions(ctx(), token);
    const response = await new SoftAuthenticator().register(options.body.options as never, "https://evil.example", SITES.bistro.rpID);
    expect((await enrolVerify(ctx("bistro", cookieValue(options.cookies[0])), token, response)).status).toBe(400);
    expect((await auditRows()).filter((r) => r.action === "update")).toEqual([]);
  });

  it("an invite used on the wrong site is refused and not audited on either site", async () => {
    const token = await invite();
    const options = await enrolOptions(ctx("westafrican"), token);
    expect(options.status).not.toBe(200);
    expect((await auditRows()).map((r) => `${r.site_id}:${r.entity}.${r.action}`)).toEqual(["bistro:invite.create"]);
  });

  it("enrolling an already-registered credential from a second invite: refused, no audit row", async () => {
    const { auth } = await enrol();
    const token = await invite();
    const options = await enrolOptions(ctx(), token);
    // Same credential id again (the authenticator generates a fresh key but keeps its id).
    const response = await auth.register(options.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const result = await enrolVerify(ctx("bistro", cookieValue(options.cookies[0])), token, response);
    expect(result.status).not.toBe(200);
    expect((await auditRows()).filter((r) => r.action === "update")).toHaveLength(1);
  });

  it("two enrolments racing on one invite: one passkey, one audit row", async () => {
    const token = await invite();
    const options = await enrolOptions(ctx(), token);
    const cookie = cookieValue(options.cookies[0]);
    const a = await new SoftAuthenticator().register(options.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const b = await new SoftAuthenticator().register(options.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const results = await Promise.all([enrolVerify(ctx("bistro", cookie), token, a), enrolVerify(ctx("bistro", cookie), token, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(await db.prepare("SELECT count(*) AS n FROM passkeys").first<number>("n")).toBe(1);
    expect((await auditRows()).filter((r) => r.action === "update")).toHaveLength(1);
  });

  it("adding a device with a replayed challenge (new credential, same challenge) is refused and not audited", async () => {
    const { token } = await enrol();
    const signedIn = await session(token);
    const options = await confirmedAddOptions((c) => ctx("bistro", c), signedIn, SITES.bistro.origin, SITES.bistro.rpID);
    const cookie = cookieValue(options.cookies[0]);
    const first = await new SoftAuthenticator().register(options.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    const second = await new SoftAuthenticator().register(options.body.options as never, SITES.bistro.origin, SITES.bistro.rpID);
    expect((await addPasskeyVerify(ctx("bistro", cookie), signedIn, first)).status).toBe(200);
    expect((await addPasskeyVerify(ctx("bistro", cookie), signedIn, second)).status).toBe(409);
    expect((await auditRows()).filter((r) => r.entity === "passkey" && r.action === "create")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) AS n FROM passkeys").first<number>("n")).toBe(2);
  });

  it("adding a device with a failed verification is not audited", async () => {
    const { token } = await enrol();
    const signedIn = await session(token);
    const options = await confirmedAddOptions((c) => ctx("bistro", c), signedIn, SITES.bistro.origin, SITES.bistro.rpID);
    const bad = await new SoftAuthenticator().register(options.body.options as never, SITES.bistro.origin, "evil.example");
    expect((await addPasskeyVerify(ctx("bistro", cookieValue(options.cookies[0])), signedIn, bad)).status).toBe(400);
    expect((await auditRows()).filter((r) => r.entity === "passkey")).toEqual([]);
  });

  it("a sign-in is not a security event and writes no audit row", async () => {
    const { auth } = await enrol();
    const before = (await auditRows()).length;
    await login(auth);
    expect(await auditRows()).toHaveLength(before);
  });

  it("removing a passkey twice: one row; the second removal is refused", async () => {
    const { token } = await enrol();
    const second = await addDevice(await session(token));
    expect(await removePasskey(db, await session(token), second.id, now)).toBe("removed");
    expect(await removePasskey(db, await session(token), second.id, now)).toBe("not-removed");
    expect((await auditRows()).filter((r) => r.entity === "passkey" && r.action === "delete")).toHaveLength(1);
  });

  it("two removals racing for an owner's two passkeys: one goes, the last stays, one audit row", async () => {
    const { auth: phone, token } = await enrol();
    const laptop = await addDevice(await session(token));
    const current = await legacySession();
    const s = await session(current);
    const results = await Promise.all([removePasskey(db, s, phone.id, now), removePasskey(db, s, laptop.id, now)]);
    expect(results.sort()).toEqual(["not-removed", "removed"]);
    expect(await db.prepare("SELECT count(*) AS n FROM passkeys").first<number>("n")).toBe(1);
    expect((await auditRows()).filter((r) => r.entity === "passkey" && r.action === "delete")).toHaveLength(1);
  });

  it("revoking twice: one row", async () => {
    await enrol();
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    expect((await auditRows()).filter((r) => r.entity === "membership")).toHaveLength(1);
  });

  it("revoking on bistro is audited on bistro only and leaves the westafrican membership, passkey and session", async () => {
    await enrol(OWNER, "bistro");
    const { token: wa } = await enrol(OWNER, "westafrican");
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    const revoked = (await auditRows()).filter((r) => r.entity === "membership");
    expect(revoked.map((r) => [r.site_id, r.summary])).toEqual([["bistro", `${OWNER}: access revoked; passkeys removed: 1`]]);
    expect(await alive(wa, "westafrican")).toBe(true);
  });

  it("revoke's audit row has a timestamp in the same format as the others", async () => {
    await enrol();
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    for (const r of await auditRows()) expect(r.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("an invite for a malformed email throws before anything is written", async () => {
    await expect(issueInvite("bistro", "not-an-email", now)).rejects.toThrow();
    expect(await auditRows()).toEqual([]);
  });

  it("an invite for a site that doesn't exist writes nothing (the batch fails as a whole)", async () => {
    const issued = await issueInvite("nosuchsite", OWNER, now);
    await expect(db.batch(prepare(db, issued.statements))).rejects.toThrow();
    expect(await auditRows()).toEqual([]);
  });

  it("an invite on westafrican for someone with a bistro passkey is not called a recovery", async () => {
    await enrol(OWNER, "bistro");
    await invite(OWNER, "westafrican");
    const wa = (await auditRows()).filter((r) => r.site_id === "westafrican");
    expect(wa.map((r) => r.summary)).toEqual([`${OWNER}: invited as owner; link valid 72 hours`]);
  });

  it("sign out everywhere, submitted twice at once (two tabs), is recorded once", async () => {
    const { token } = await enrol();
    const s = await session(token);
    await Promise.all([signOutEverywhere(db, s, now), signOutEverywhere(db, s, now)]);
    const rows = (await auditRows()).filter((r) => r.entity === "sessions");
    // ADR-011 §6 / criterion 1: an audit row only when the event happened. The second
    // submission ends no sign-ins; it currently writes "sign-ins ended: 0".
    expect(rows).toHaveLength(1);
  });
});

describe("criterion 2: no token, token hash or credential id in the audit log or history", () => {
  it("across every event in one owner's life", async () => {
    const { auth: phone, token: phoneSession, invite: firstInvite } = await enrol();
    const laptop = await addDevice(await session(phoneSession));
    const laptopSession = await login(laptop);
    const { auth: recovered, invite: recoveryInvite, token: recoveredSession } = await enrol();
    expect(await removePasskey(db, await session(phoneSession), laptop.id, now)).toBe("removed");
    await signOutEverywhere(db, await session(recoveredSession), now);
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    await expectNoSecrets([firstInvite, recoveryInvite, phoneSession, laptopSession, recoveredSession]);
    const dump = JSON.stringify(await auditRows());
    for (const id of [phone.id, laptop.id, recovered.id]) expect(dump).not.toContain(id);
    // entity_id is always a user id (or null), never anything else.
    const ids = new Set((await auditRows()).map((r) => r.entity_id));
    expect([...ids]).toEqual([await userId()]);
  });

  it("an email address that contains SQL-ish text is stored as data, not run", async () => {
    const odd = "o'brien@bistro.se";
    await enrol(odd);
    expect((await auditRows()).map((r) => r.summary)[0]).toBe(`${odd}: invited as owner; link valid 72 hours`);
  });
});

describe("criteria 3 and 4: which sessions a removal ends", () => {
  it("other site untouched: the same person's westafrican sessions, attributed and legacy, survive", async () => {
    const { token } = await enrol(OWNER, "bistro");
    const second = await addDevice(await session(token));
    const { token: wa } = await enrol(OWNER, "westafrican");
    const waLegacy = await legacySession(OWNER, "westafrican");
    const current = await legacySession(OWNER, "bistro");
    expect(await removePasskey(db, await session(current), second.id, now)).toBe("removed");
    expect(await alive(wa, "westafrican")).toBe(true);
    expect(await alive(waLegacy, "westafrican")).toBe(true);
  });

  it("a bistro session can't remove the same person's westafrican passkey", async () => {
    const { token } = await enrol(OWNER, "bistro");
    await addDevice(await session(token));
    const { auth: waKey, token: wa } = await enrol(OWNER, "westafrican");
    await addDevice(await session(wa, "westafrican"), new SoftAuthenticator(), "westafrican");
    const before = await allSessions();
    expect(await removePasskey(db, await session(token), waKey.id, now)).toBe("not-removed");
    expect(await allSessions()).toEqual(before);
    expect(await auditRows().then((r) => r.filter((x) => x.action === "delete"))).toEqual([]);
  });

  it("refusals end nothing: last passkey, bogus id, another owner's id, empty id", async () => {
    const { auth, token } = await enrol();
    const { auth: chef } = await enrol(CHEF);
    await legacySession(CHEF);
    const current = await legacySession();
    await legacySession();
    const before = await allSessions();
    const s = await session(current);
    for (const id of [auth.id, "bogus", chef.id, "", "null"]) expect(await removePasskey(db, s, id, now)).toBe("not-removed");
    expect(await allSessions()).toEqual(before);
    expect(await alive(token)).toBe(true);
  });

  it("removing a passkey while signed in with a legacy session keeps that session and returns 'removed'", async () => {
    const { auth: phone, token } = await enrol();
    await addDevice(await session(token));
    const current = await legacySession();
    expect(await removePasskey(db, await session(current), phone.id, now)).toBe("removed");
    expect(await alive(current)).toBe(true);
    expect(await alive(token)).toBe(false);
  });

  it("the audit count matches the sign-ins actually ended (attributed + other legacy)", async () => {
    const { token } = await enrol();
    const laptop = await addDevice(await session(token));
    await login(laptop);
    await legacySession();
    await legacySession();
    const current = await legacySession();
    const before = (await allSessions()).length;
    expect(await removePasskey(db, await session(current), laptop.id, now)).toBe("removed");
    const ended = before - (await allSessions()).length;
    expect(ended).toBe(3);
    expect((await auditRows()).at(-1)!.summary).toMatch(/sign-ins ended: 3$/);
  });

  it("racing removals of the same passkey from two legacy sessions don't end the winner's own session", async () => {
    const { token } = await enrol();
    const laptop = await addDevice(await session(token));
    const a = await legacySession();
    const b = await legacySession();
    const [sa, sb] = [await session(a), await session(b)];
    const results = await Promise.all([removePasskey(db, sa, laptop.id, now), removePasskey(db, sb, laptop.id, now)]);
    expect([...results].sort()).toEqual(["not-removed", "removed"]);
    // The winner removed the passkey and keeps its session; the loser's refused removal
    // must end nothing (criterion 4), so the winner's session survives.
    const winner = results[0] === "removed" ? a : b;
    expect(await alive(winner)).toBe(true);
  });
});

describe("criterion 6: audit rows don't bump content_version", () => {
  it("for every security event, on both sites", async () => {
    const [b0, w0] = [await version("bistro"), await version("westafrican")];
    const { auth, token } = await enrol();
    const laptop = await addDevice(await session(token));
    await login(auth);
    await legacySession();
    expect(await removePasskey(db, await session(token), laptop.id, now)).toBe("removed");
    await enrol();
    await signOutEverywhere(db, await session(await login(auth)), now);
    await db.batch(prepare(db, revokeStatements("bistro", OWNER)));
    expect(await version("bistro")).toBe(b0);
    expect(await version("westafrican")).toBe(w0);
  });
});

describe("criterion 7: history labels", () => {
  it("every security event has a non-empty label in sv and en, distinct per event", () => {
    for (const dict of [sv, en] as Record<string, string>[]) {
      const labels = SECURITY_EVENTS.map((e) => dict[`admin.history.event.${e.entity}.${e.action}`]);
      for (const l of labels) expect(l, JSON.stringify(labels)).toBeTruthy();
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("content history entries keep their shape alongside security events", async () => {
    const { token } = await enrol();
    await db
      .prepare("INSERT INTO audit_log (site_id, user_id, at, entity, entity_id, action, summary) VALUES ('bistro', ?, ?, 'menu_item', 'abc', 'update', 'Pasta')")
      .bind(await userId(), "2026-10-17T10:00:00Z")
      .run();
    await signOutEverywhere(db, await session(token), now);
    const history = await recentChanges({ db, siteId: "bistro", userId: null, now });
    expect(history.map((c) => `${c.entity}.${c.action}`)).toEqual(["sessions.delete", "menu_item.update", "invite.update", "invite.create"]);
    expect(history[1]).toMatchObject({ summary: "Pasta", by: OWNER });
  });

  it("bistro's history shows none of westafrican's security events", async () => {
    await enrol(CHEF, "westafrican");
    expect(await recentChanges({ db, siteId: "bistro", userId: null, now })).toEqual([]);
  });
});

describe("criterion 8: migration 0004 is expand-compatible", () => {
  it("passkey_id is nullable and old-style inserts still sign in", async () => {
    await enrol();
    const t = await legacySession();
    expect((await session(t)).passkeyId).toBeNull();
  });

  it("a session can't name a passkey that doesn't exist (foreign key enforced)", async () => {
    await enrol();
    await expect(
      db.batch(
        prepare(db, [
          stmt(
            "INSERT INTO sessions (token_hash, user_id, site_id, passkey_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', 'ghost', ?, ?, ?)",
            "b".repeat(64),
            await userId(),
            "2026-10-17T09:00:00Z",
            "2026-10-17T09:00:00Z",
            "2026-11-16T09:00:00Z",
          ),
        ]),
      ),
    ).rejects.toThrow();
  });

  it("the column and index exist as the migration declares", async () => {
    const cols = (await db.prepare("PRAGMA table_info(sessions)").all<{ name: string; notnull: number }>()).results;
    expect(cols.find((c) => c.name === "passkey_id")).toMatchObject({ notnull: 0 });
    const idx = (await db.prepare("PRAGMA index_list(sessions)").all<{ name: string }>()).results.map((i) => i.name);
    expect(idx).toContain("sessions_passkey");
  });
});
