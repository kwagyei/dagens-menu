/**
 * Plan M4.2: nothing is written to D1 before the browser's passkey response verifies.
 * (The successful ceremonies are covered end to end in tests/e2e/admin.spec.ts.)
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sign } from "../../src/auth/crypto";
import { findInvite, issueInvite } from "../../src/auth/invites";
import { type CeremonyContext, enrolOptions, enrolVerify, loginOptions, loginVerify } from "../../src/auth/passkeys";
import { prepare } from "../../src/db/sql";
import type { D1Database } from "../../src/db/types";

const db = env.DB;
const SECRET = "s".repeat(32);
const now = new Date("2026-10-16T10:00:00Z");

/** A D1 binding that records every statement it's asked to run. */
function recording(real: D1Database) {
  const sql: string[] = [];
  const binding = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (text: string) => (sql.push(text), target.prepare(text));
      return Reflect.get(target, prop);
    },
  });
  return { binding, writes: () => sql.filter((s) => !/^\s*SELECT\b/i.test(s)) };
}

const ctx = (binding: D1Database, challengeCookie?: string): CeremonyContext => ({
  db: binding,
  site: "bistro",
  siteName: "Bistro Norden",
  secret: SECRET,
  origin: "https://bistro.example",
  rpID: "bistro.example",
  now,
  challengeCookie,
});

let token: string;
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users"), db.prepare("INSERT INTO sites (id) VALUES ('bistro')")]);
  const issued = await issueInvite("bistro", "owner@bistro.se", now);
  await db.batch(prepare(db, issued.statements));
  token = issued.token;
});

describe("starting a ceremony", () => {
  it("writes nothing: enrolment options come from the invite, the challenge goes in a cookie", async () => {
    const { binding, writes } = recording(db);
    const result = await enrolOptions(ctx(binding), token);
    expect(result.status).toBe(200);
    expect(result.cookies[0]).toMatch(/^__Host-dm_challenge=.+; Path=\/; Max-Age=300; HttpOnly; Secure; SameSite=Strict$/);
    expect(writes()).toEqual([]);
  });

  it("writes nothing for sign-in options", async () => {
    const { binding, writes } = recording(db);
    await loginOptions(ctx(binding));
    expect(writes()).toEqual([]);
  });

  it("refuses an invalid invite without writing", async () => {
    const { binding, writes } = recording(db);
    expect((await enrolOptions(ctx(binding), "A".repeat(43))).status).toBe(410);
    expect(writes()).toEqual([]);
  });
});

describe("finishing a ceremony that doesn't verify", () => {
  const forged = { id: "abc", rawId: "abc", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA" }, clientExtensionResults: {} };

  it("writes nothing without a challenge cookie", async () => {
    const { binding, writes } = recording(db);
    expect((await enrolVerify(ctx(binding), token, forged)).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("writes nothing for a forged response, and the invite stays usable", async () => {
    const invite = (await findInvite(db, "bistro", token, now))!;
    const cookie = await sign(SECRET, `enrol:${invite.tokenHash}`, "challenge123", new Date(now.getTime() + 60_000));
    const { binding, writes } = recording(db);
    expect((await enrolVerify(ctx(binding, cookie), token, forged)).status).toBe(400);
    expect(writes()).toEqual([]);
    expect(await findInvite(db, "bistro", token, now)).not.toBeNull();
  });

  it("won't take a challenge issued for a different invite", async () => {
    const other = await issueInvite("bistro", "chef@bistro.se", now);
    await db.batch(prepare(db, other.statements));
    const otherInvite = (await findInvite(db, "bistro", other.token, now))!;
    const cookie = await sign(SECRET, `enrol:${otherInvite.tokenHash}`, "challenge123", new Date(now.getTime() + 60_000));
    const { binding, writes } = recording(db);
    expect((await enrolVerify(ctx(binding, cookie), token, forged)).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it("writes nothing for a sign-in with an unknown passkey", async () => {
    const cookie = await sign(SECRET, "login", "challenge123", new Date(now.getTime() + 60_000));
    const { binding, writes } = recording(db);
    expect((await loginVerify(ctx(binding, cookie), { id: "nope", response: {} })).status).toBe(401);
    expect(writes()).toEqual([]);
  });
});
