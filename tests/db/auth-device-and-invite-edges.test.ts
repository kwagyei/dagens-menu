/**
 * Tester, review Lows (17 Oct): user verification on the add-a-device path (L9), the read-only
 * invite check (L8) beyond the happy cases, and the post-deploy batch-guard check (M2) when a
 * step throws or real sites hold content.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueInvite, revokeStatements } from "../../src/auth/invites";
import { addPasskeyVerify, type CeremonyContext, checkInvite, enrolOptions, enrolVerify } from "../../src/auth/passkeys";
import { getSession } from "../../src/auth/sessions";
import { CHECK_SITE, checkBatchGuard } from "../../src/db/deploy-check";
import { prepare } from "../../src/db/sql";
import type { D1Database } from "../../src/db/types";
import { confirmedAddOptions } from "./add-device";
import { SoftAuthenticator } from "./soft-authenticator";

const db = env.DB;
const now = new Date("2026-10-17T10:00:00Z");
const BISTRO = { site: "bistro", origin: "https://bistro.example", rpID: "bistro.example" };

const ctx = (challengeCookie?: string, site = "bistro"): CeremonyContext => ({
  db,
  site,
  siteName: site,
  secret: "l".repeat(32),
  origin: BISTRO.origin,
  rpID: BISTRO.rpID,
  now,
  challengeCookie,
});
const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");
const sessionToken = (cookies: string[]) => cookieValue(cookies.find((c) => c.startsWith("__Host-dm_admin="))!);
const count = async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).first<number>("n"))!;

async function invite(site = "bistro", email = "owner@bistro.se") {
  const issued = await issueInvite(site, email, now);
  await db.batch(prepare(db, issued.statements));
  return issued.token;
}

async function enrolled() {
  const token = await invite();
  const options = await enrolOptions(ctx(), token);
  const auth = new SoftAuthenticator();
  const response = await auth.register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
  const result = await enrolVerify(ctx(cookieValue(options.cookies[0])), token, response);
  expect(result.status).toBe(200);
  return (await getSession(db, "bistro", sessionToken(result.cookies), now))!;
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')")]);
});

describe("adding a device requires user verification (review L9)", () => {
  it("asks the new device to verify the user", async () => {
    const session = await enrolled();
    const options = await confirmedAddOptions((c) => ctx(c), session, BISTRO.origin, BISTRO.rpID);
    expect((options.body.options as { authenticatorSelection: { userVerification: string } }).authenticatorSelection.userVerification).toBe("required");
  });

  it("refuses a second device that only saw the user present, and stores nothing", async () => {
    const session = await enrolled();
    const options = await confirmedAddOptions((c) => ctx(c), session, BISTRO.origin, BISTRO.rpID);
    const device = Object.assign(new SoftAuthenticator(), { verified: false });
    const response = await device.register(options.body.options as never, BISTRO.origin, BISTRO.rpID);
    const result = await addPasskeyVerify(ctx(cookieValue(options.cookies[0])), session, response);
    expect(result.status).toBe(400);
    expect(await count("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", session.userId)).toBe(1);
  });
});

describe("checkInvite edge cases (review L8)", () => {
  it("answers 410 for an invite whose owner was revoked", async () => {
    const token = await invite();
    await db.batch(prepare(db, revokeStatements("bistro", "owner@bistro.se")));
    expect((await checkInvite(ctx(), token)).status).toBe(410);
  });

  it("answers 410 for near-miss tokens: whitespace, case, a suffix, very long, empty", async () => {
    const token = await invite();
    for (const bad of [` ${token}`, `${token} `, token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(), `${token}x`, token.slice(1), "", "x".repeat(100_000), encodeURIComponent(`#${token}`)]) {
      const result = await checkInvite(ctx(), bad);
      expect(result.status, JSON.stringify(bad.slice(0, 60))).toBe(410);
      expect(result.body).toEqual({ error: "invite-invalid" });
      expect(result.cookies).toEqual([]);
    }
    expect((await checkInvite(ctx(), token)).status).toBe(200);
  });

  it("reveals only the invitee's email, nothing about the site's other owners", async () => {
    await invite("bistro", "first@bistro.se");
    const token = await invite("bistro", "second@bistro.se");
    const result = await checkInvite(ctx(), token);
    expect(Object.keys(result.body)).toEqual(["email"]);
    expect(result.body.email).toBe("second@bistro.se");
  });
});

describe("checkBatchGuard (review M2)", () => {
  async function bistroWithContent() {
    await db.batch([
      db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('bistro', 'realcategor1', 'mains', 'Varmrätter', 'Mains', 0)"),
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES ('bistro', '2026-10-17T09:00:00Z', 'category', 'update', 'a real save')"),
    ]);
    return snapshot();
  }
  const snapshot = async () => ({
    version: await count("SELECT content_version AS n FROM sites WHERE id = 'bistro'"),
    categories: await count("SELECT count(*) AS n FROM menu_categories WHERE site_id != ?", CHECK_SITE),
    audits: await count("SELECT count(*) AS n FROM audit_log WHERE site_id != ?", CHECK_SITE),
    sites: await count("SELECT count(*) AS n FROM sites WHERE id != ?", CHECK_SITE),
  });
  const leftovers = () =>
    count("SELECT (SELECT count(*) FROM sites WHERE id = ?1) + (SELECT count(*) FROM audit_log WHERE site_id = ?1) + (SELECT count(*) FROM menu_categories WHERE site_id = ?1) AS n", CHECK_SITE);

  it("leaves real sites' content, versions and audit history exactly as they were", async () => {
    const before = await bistroWithContent();
    expect(await checkBatchGuard(db, now)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await leftovers()).toBe(0);
  });

  it("cleans up and restores console.warn when a step throws halfway", async () => {
    const before = await bistroWithContent();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let batches = 0;
    // The second batch (commitIf's save) fails, as a dropped connection would.
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return (statements: unknown[]) => {
            if (++batches === 2) return Promise.reject(new Error("network gone"));
            return target.batch(statements as never);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(checkBatchGuard(flaky, now)).rejects.toThrow("network gone");
    // The check's own capture is gone: a warning after it reaches the real console again.
    console.warn("after the check");
    expect(warn).toHaveBeenCalledWith("after the check");
    warn.mockRestore();
    expect(await leftovers()).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("cleans up a leftover that still has categories and audit rows from a run that died", async () => {
    await db.batch([
      db.prepare("INSERT INTO sites (id) VALUES (?)").bind(CHECK_SITE),
      db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES (?, 'deploycheck1', 'check', 'K', 'C', 0)").bind(CHECK_SITE),
      db.prepare("INSERT INTO audit_log (site_id, at, entity, action, summary) VALUES (?, '2026-10-17T09:00:00Z', 'check', 'update', 'old')").bind(CHECK_SITE),
    ]);
    expect(await checkBatchGuard(db, now)).toEqual([]);
    expect(await leftovers()).toBe(0);
  });

  it("detects a guard that sees a stale non-zero changes() (a save that matched nothing still audited)", async () => {
    const stale = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => target.prepare(sql.replace(/WHERE changes\(\) (> 0|= 1)/, "WHERE 1"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const problems = await checkBatchGuard(stale, now);
    expect(problems).toContain("a save that matched no row still wrote an audit row");
    expect(await leftovers()).toBe(0);
    vi.restoreAllMocks();
  });
});
