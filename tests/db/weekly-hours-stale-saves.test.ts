/** Tester, review finding M4: stale weekly-hours saves, tokens and the one-statement guard. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import { adminHours, parseWeeklyToken, saveWeeklyHours, weeklyToken, type Hours } from "../../src/db/hours";
import type { RepoContext } from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { WEEKDAYS, type Weekday } from "../../src/content/vocabulary";

const db = env.DB;
const now = new Date("2026-10-16T08:00:00Z");
const ctx = (siteId = "bistro"): RepoContext => ({ db, siteId, userId: null, now });
const bistro = ctx();
type Week = Record<Weekday, Hours | null>;
const seededWeek = hours.weekly as Week;

const content = {
  settings,
  hours,
  menu: { categories: menu.categories.map((c) => ({ ...c, items: c.items.map(({ image: _i, ...i }) => i) })) },
  pages: { home: { tagline: pages.home.tagline, highlights: pages.home.highlights }, menu: {}, about: { story: pages.about.story, chef: pages.about.chef } },
  gallery: { images: [] },
  images: [],
} as unknown as StoredContent;

const version = () => db.prepare("SELECT content_version FROM sites WHERE id = 'bistro'").first<number>("content_version");
const audits = () => db.prepare("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro' AND entity = 'hours'").first<number>("n");
const rows = () => db.prepare("SELECT weekday, opens, closes FROM weekly_hours WHERE site_id = 'bistro' ORDER BY weekday").all();

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content, () => ({ id: "0".repeat(64), mime: "image/jpeg" }))));
  await db.prepare("INSERT INTO sites (id) VALUES ('westafrican')").run();
});

describe("token format", () => {
  it("is seven comma-separated days, Monday first, and round-trips", async () => {
    const t = (await adminHours(bistro)).weeklyToken;
    expect(t).toBe("11:00-22:00,11:00-22:00,11:00-22:00,11:00-23:00,11:00-23:00,12:00-23:00,closed");
    expect(parseWeeklyToken(t)).toEqual(seededWeek);
    expect(weeklyToken(parseWeeklyToken(t)!)).toBe(t);
  });
});

describe("conflict writes nothing at all (AC1)", () => {
  it("refuses a stale multi-day save with no partial days, no version bump, no audit row", async () => {
    const seen = await adminHours(bistro);
    await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, monday: null });
    const before = { rows: (await rows()).results, v: await version(), a: await audits() };
    const mine = Object.fromEntries(WEEKDAYS.map((d) => [d, { open: "09:00", close: "10:00" }])) as Week;
    const r = await saveWeeklyHours(bistro, seen.weeklyToken, mine);
    expect(r.ok).toBe(false);
    expect({ rows: (await rows()).results, v: await version(), a: await audits() }).toEqual(before);
  });

  it("a stale form conflicts even when only one of the other person's days differs from the token", async () => {
    const seen = await adminHours(bistro);
    await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, saturday: { open: "12:00", close: "23:30" } });
    const v = await version();
    const r = await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, monday: null });
    expect(r).toMatchObject({ ok: false, error: "conflict" });
    expect((await adminHours(bistro)).weekly.monday).toEqual(seededWeek.monday);
    expect(await version()).toBe(v);
  });

  it("a conflict reply carries the token of the stored week, and using it succeeds", async () => {
    const seen = await adminHours(bistro);
    await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, tuesday: null });
    const mine = { ...seen.weekly, wednesday: null };
    const r = await saveWeeklyHours(bistro, seen.weeklyToken, mine);
    if (r.ok || r.error !== "conflict") throw new Error("expected conflict");
    expect(r.current).toBe((await adminHours(bistro)).weeklyToken);
    expect(await saveWeeklyHours(bistro, r.current, mine)).toEqual({ ok: true });
    expect((await adminHours(bistro)).weekly).toEqual(mine); // Tuesday knowingly overwritten
  });
});

describe("tokens that lie (AC4)", () => {
  const garbage = [
    "",
    " ",
    "null",
    "undefined",
    "closed,closed,closed,closed,closed,closed",
    "closed,closed,closed,closed,closed,closed,closed,closed",
    "11:00-22:00,11:00-22:00,11:00-22:00,11:00-23:00,11:00-23:00,12:00-23:00,closed ",
    " 11:00-22:00,11:00-22:00,11:00-22:00,11:00-23:00,11:00-23:00,12:00-23:00,closed",
    "CLOSED,CLOSED,CLOSED,CLOSED,CLOSED,CLOSED,CLOSED",
    "11:00-22:00-23:00,closed,closed,closed,closed,closed,closed",
    "11:00-11:00,closed,closed,closed,closed,closed,closed",
    "'; DROP TABLE weekly_hours; --",
    "closed,".repeat(7000),
    "11:00–22:00,11:00–22:00,11:00–22:00,11:00–23:00,11:00–23:00,12:00–23:00,closed", // en dash
  ];
  it.each(garbage.map((g, i) => [i, g]))("garbage token #%i is a conflict, never a write", async (_i, token) => {
    const v = await version();
    const r = await saveWeeklyHours(bistro, token as string, { ...seededWeek, monday: null });
    expect(r).toMatchObject({ ok: false, error: "conflict" });
    expect((await adminHours(bistro)).weekly).toEqual(seededWeek);
    expect(await version()).toBe(v);
    expect(await audits()).toBe(0);
  });

  it("garbage token with a save equal to the stored week is unchanged, not a write", async () => {
    expect(await saveWeeklyHours(bistro, "garbage", seededWeek)).toEqual({ ok: true, unchanged: true });
    expect(await audits()).toBe(0);
  });

  it("a well-formed but wrong token (claims the week was all closed) cannot write", async () => {
    const claimed = Array(7).fill("closed").join(",");
    const r = await saveWeeklyHours(bistro, claimed, { ...seededWeek, sunday: { open: "12:00", close: "16:00" } });
    expect(r).toMatchObject({ ok: false, error: "conflict" });
    expect((await adminHours(bistro)).weekly.sunday).toBeNull();
  });

  it("a forged token that matches the stored week is, by design, accepted (token is content, not a secret)", async () => {
    const t = (await adminHours(bistro)).weeklyToken;
    expect(await saveWeeklyHours(bistro, t, { ...seededWeek, sunday: { open: "12:00", close: "16:00" } })).toEqual({ ok: true });
  });
});

describe("validation comes before the token check (AC8 at repository level)", () => {
  it("invalid hours with a stale token are reported as invalid and write nothing", async () => {
    const r = await saveWeeklyHours(bistro, "garbage", { ...seededWeek, monday: { open: "25:00", close: "22:00" } });
    expect(r).toMatchObject({ ok: false, error: "invalid" });
    expect(await audits()).toBe(0);
  });
});

describe("races and no-ops (AC5)", () => {
  it("two simultaneous saves from the same token: exactly one wins, one audit row, no mixed week", async () => {
    const seen = await adminHours(bistro);
    const a = { ...seen.weekly, monday: null, tuesday: null };
    const b = { ...seen.weekly, saturday: null, sunday: { open: "10:00", close: "12:00" } };
    const [ra, rb] = await Promise.all([saveWeeklyHours(bistro, seen.weeklyToken, a), saveWeeklyHours(bistro, seen.weeklyToken, b)]);
    expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
    const final = (await adminHours(bistro)).weekly;
    expect([a, b]).toContainEqual(final);
    expect(await audits()).toBe(1);
  });

  it("two simultaneous identical saves: one writes, the other is unchanged", async () => {
    const seen = await adminHours(bistro);
    const same = { ...seen.weekly, sunday: { open: "12:00", close: "16:00" } };
    const rs = await Promise.all([saveWeeklyHours(bistro, seen.weeklyToken, same), saveWeeklyHours(bistro, seen.weeklyToken, same)]);
    expect(rs).toContainEqual({ ok: true });
    expect(rs).toContainEqual({ ok: true, unchanged: true });
    expect(await audits()).toBe(1);
  });

  it("a stale form that changed nothing, after another person's change, writes nothing and is not a conflict", async () => {
    const seen = await adminHours(bistro);
    await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, friday: null });
    const v = await version();
    const a = await audits();
    expect(await saveWeeklyHours(bistro, seen.weeklyToken, seen.weekly)).toEqual({ ok: true, unchanged: true });
    expect(await version()).toBe(v);
    expect(await audits()).toBe(a);
    expect((await adminHours(bistro)).weekly.friday).toBeNull(); // their change stays
  });

  it("repeated unchanged saves never move version or audit", async () => {
    const t = (await adminHours(bistro)).weeklyToken;
    const v = await version();
    for (let i = 0; i < 5; i++) expect(await saveWeeklyHours(bistro, t, seededWeek)).toEqual({ ok: true, unchanged: true });
    expect(await version()).toBe(v);
    expect(await audits()).toBe(0);
  });
});

describe("rows and sites (AC7)", () => {
  it("a day with no row reads as closed, the token says closed, and opening it works", async () => {
    await db.prepare("DELETE FROM weekly_hours WHERE site_id = 'bistro' AND weekday = 6").run();
    await db.prepare("DELETE FROM weekly_hours WHERE site_id = 'bistro' AND weekday = 0").run();
    const cur = await adminHours(bistro);
    expect(cur.weekly.sunday).toBeNull();
    expect(cur.weekly.monday).toBeNull();
    expect(cur.weeklyToken.split(",")[0]).toBe("closed");
    expect(await saveWeeklyHours(bistro, cur.weeklyToken, cur.weekly)).toEqual({ ok: true, unchanged: true });
    expect(await saveWeeklyHours(bistro, cur.weeklyToken, { ...cur.weekly, monday: { open: "11:00", close: "22:00" } })).toEqual({ ok: true });
    expect((await adminHours(bistro)).weekly.monday).toEqual({ open: "11:00", close: "22:00" });
  });

  it("a stale token from the other site's week cannot be used to write to this one", async () => {
    const wa = ctx("westafrican");
    const waToken = (await adminHours(wa)).weeklyToken; // all closed
    const r = await saveWeeklyHours(bistro, waToken, { ...seededWeek, monday: null });
    expect(r).toMatchObject({ ok: false, error: "conflict" });
    expect((await adminHours(bistro)).weekly).toEqual(seededWeek);
  });

  it("a conflict on one site leaves the other site untouched and its saves unaffected", async () => {
    const wa = ctx("westafrican");
    const waSeen = await adminHours(wa);
    await saveWeeklyHours(bistro, "x", { ...seededWeek, monday: null });
    expect(await saveWeeklyHours(wa, waSeen.weeklyToken, { ...waSeen.weekly, friday: { open: "17:00", close: "23:00" } })).toEqual({ ok: true });
    expect((await adminHours(bistro)).weekly).toEqual(seededWeek);
  });

  it("a write on the other site makes this site's form neither stale nor changed", async () => {
    const seen = await adminHours(bistro);
    await saveWeeklyHours(ctx("westafrican"), (await adminHours(ctx("westafrican"))).weeklyToken, { ...seen.weekly });
    expect(await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, sunday: { open: "12:00", close: "16:00" } })).toEqual({ ok: true });
  });
});
