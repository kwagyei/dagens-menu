/** Plan M4.1: invites are hash-only, single-use, expire after 72 hours and belong to one site. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/crypto";
import { consumeInviteStatement, findInvite, INVITE_TTL_MS, issueInvite, revokeStatements } from "../../src/auth/invites";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-16T10:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro'), ('westafrican')")]);
});

async function invite(site = "bistro", email = "Owner@Bistro.se", at = now) {
  const issued = await issueInvite(site, email, at);
  await db.batch(prepare(db, issued.statements));
  return issued.token;
}

describe("issueInvite", () => {
  it("makes the person an owner of the site and stores only the token's hash", async () => {
    const token = await invite();
    const membership = await db.prepare("SELECT u.email, m.role, m.site_id FROM memberships m JOIN users u ON u.id = m.user_id").first();
    expect(membership).toEqual({ email: "owner@bistro.se", role: "owner", site_id: "bistro" });
    const stored = await db.prepare("SELECT token_hash FROM invites").first<string>("token_hash");
    expect(stored).toBe(await sha256Hex(token));
    const everything = JSON.stringify((await db.prepare("SELECT * FROM invites").all()).results);
    expect(everything).not.toContain(token);
  });

  it("re-inviting the same email reuses the account and adds an invite", async () => {
    await invite();
    await invite("bistro", "owner@bistro.se");
    expect(await db.prepare("SELECT count(*) AS n FROM users").first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) AS n FROM invites").first("n")).toBe(2);
  });

  it("refuses something that isn't an email address", async () => {
    await expect(issueInvite("bistro", "not an email", now)).rejects.toThrow(/not an email/);
  });
});

describe("findInvite", () => {
  it("finds a fresh invite for its own site", async () => {
    const token = await invite();
    expect(await findInvite(db, "bistro", token, now)).toMatchObject({ email: "owner@bistro.se" });
  });

  it("is valid for 72 hours and not a second longer", async () => {
    const token = await invite();
    expect(await findInvite(db, "bistro", token, later(INVITE_TTL_MS - 1000))).not.toBeNull();
    expect(await findInvite(db, "bistro", token, later(INVITE_TTL_MS))).toBeNull();
  });

  it("doesn't work on another site", async () => {
    const token = await invite("bistro");
    expect(await findInvite(db, "westafrican", token, now)).toBeNull();
  });

  it("rejects unknown and malformed tokens", async () => {
    await invite();
    expect(await findInvite(db, "bistro", "A".repeat(43), now)).toBeNull();
    expect(await findInvite(db, "bistro", "'; DROP TABLE invites; --", now)).toBeNull();
  });
});

describe("consumeInviteStatement", () => {
  it("uses the invite up exactly once", async () => {
    const token = await invite();
    const pending = (await findInvite(db, "bistro", token, now))!;
    const first = await db.batch(prepare(db, [consumeInviteStatement("bistro", pending.tokenHash, now)]));
    const second = await db.batch(prepare(db, [consumeInviteStatement("bistro", pending.tokenHash, now)]));
    expect([first[0].meta.changes, second[0].meta.changes]).toEqual([1, 0]);
    expect(await findInvite(db, "bistro", token, now)).toBeNull();
  });

  it("can't use up an expired invite", async () => {
    const token = await invite();
    const pending = (await findInvite(db, "bistro", token, now))!;
    const result = await db.batch(prepare(db, [consumeInviteStatement("bistro", pending.tokenHash, later(INVITE_TTL_MS + 1))]));
    expect(result[0].meta.changes).toBe(0);
  });
});

describe("revokeStatements", () => {
  it("removes the membership and, with it, the invites", async () => {
    await invite();
    await db.batch(prepare(db, revokeStatements("bistro", "OWNER@bistro.se")));
    expect(await db.prepare("SELECT (SELECT count(*) FROM memberships) + (SELECT count(*) FROM invites) AS n").first("n")).toBe(0);
  });
});
