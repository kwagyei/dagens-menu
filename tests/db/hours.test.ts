/** Plan M5.4: weekly hours and dated exceptions, as the admin edits them. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import { exportSite } from "../../src/db/export";
import { addException, adminHours, removeException, saveWeeklyHours, type Hours } from "../../src/db/hours";
import type { RepoContext } from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import type { Weekday } from "../../src/content/vocabulary";

const db = env.DB;
// A Friday morning in Stockholm.
const now = new Date("2026-10-16T08:00:00Z");
const ctx = (siteId = "bistro", at = now): RepoContext => ({ db, siteId, userId: null, now: at });
const bistro = ctx();

const content = {
  settings,
  hours,
  menu: { categories: menu.categories.map((c) => ({ ...c, items: c.items.map(({ image: _i, ...i }) => i) })) },
  pages: { home: { tagline: pages.home.tagline, highlights: pages.home.highlights }, menu: {}, about: { story: pages.about.story, chef: pages.about.chef } },
  gallery: { images: [] },
} as unknown as StoredContent;

const week = (h: Hours | null): Record<Weekday, Hours | null> =>
  ({ monday: h, tuesday: h, wednesday: h, thursday: h, friday: h, saturday: h, sunday: null }) as Record<Weekday, Hours | null>;
const christmas = { date: "2026-12-24", hours: null, note: { sv: "Julafton", en: "Christmas Eve" } };
const version = () => db.prepare("SELECT content_version FROM sites WHERE id = 'bistro'").first<number>("content_version");
const audits = () => db.prepare("SELECT count(*) AS n FROM audit_log WHERE site_id = 'bistro' AND entity = 'hours'").first<number>("n");

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content, () => ({ id: "0".repeat(64), mime: "image/jpeg" }))));
  await db.prepare("INSERT INTO sites (id) VALUES ('westafrican')").run();
});

describe("weekly hours", () => {
  it("reads the seeded week", async () => {
    expect((await adminHours(bistro)).weekly).toEqual(hours.weekly);
  });

  it("saves all seven days at once, closing after midnight allowed, and the public site follows", async () => {
    const v0 = await version();
    expect(await saveWeeklyHours(bistro, (await adminHours(bistro)).weeklyToken, week({ open: "17:00", close: "01:00" }))).toEqual({ ok: true });
    expect((await adminHours(bistro)).weekly).toEqual(week({ open: "17:00", close: "01:00" }));
    expect(await version()).toBeGreaterThan(v0!);
    expect((await exportSite(db, "bistro"))?.content.hours.weekly.friday).toEqual({ open: "17:00", close: "01:00" });
  });

  it("rejects an impossible time or a day that opens and closes at once, and writes nothing", async () => {
    const bad = { ...week({ open: "11:00", close: "22:00" }), monday: { open: "25:00", close: "22:00" }, tuesday: { open: "11:00", close: "11:00" } };
    const result = await saveWeeklyHours(bistro, (await adminHours(bistro)).weeklyToken, bad);
    expect(result.ok === false && result.error === "invalid" && result.issues.map((i) => i.path)).toEqual(["monday.open", "tuesday"]);
    expect((await adminHours(bistro)).weekly).toEqual(hours.weekly);
  });

  it("an unchanged save writes nothing: no content_version bump, no audit entry", async () => {
    const v0 = await version();
    const result = await saveWeeklyHours(bistro, (await adminHours(bistro)).weeklyToken, hours.weekly as Record<Weekday, Hours | null>);
    expect(result).toEqual({ ok: true, unchanged: true });
    expect(await version()).toBe(v0);
    expect(await audits()).toBe(0);
  });

  it("a one-day change writes only that day, with one audit entry naming it", async () => {
    const before = await adminHours(bistro);
    const v0 = await version();
    expect(await saveWeeklyHours(bistro, before.weeklyToken, { ...before.weekly, sunday: { open: "12:00", close: "16:00" } })).toEqual({ ok: true });
    expect(await version()).toBe(v0! + 1); // one row written, one trigger fired
    const log = await db.prepare("SELECT summary FROM audit_log WHERE site_id = 'bistro' AND entity = 'hours'").all<{ summary: string }>();
    expect(log.results.map((r) => r.summary)).toEqual(["weekly hours: sun closed → 12:00–16:00"]);
  });

  it("a stale form is a conflict and writes nothing; saving again with the current token overwrites", async () => {
    const seen = await adminHours(bistro);
    // Someone else closes Monday in between.
    expect(await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, monday: null })).toEqual({ ok: true });
    const theirs = await adminHours(bistro);
    const v1 = await version();
    const mine = { ...seen.weekly, tuesday: { open: "10:00", close: "14:00" }, sunday: { open: "12:00", close: "16:00" } };
    const result = await saveWeeklyHours(bistro, seen.weeklyToken, mine);
    expect(result).toEqual({ ok: false, error: "conflict", current: theirs.weeklyToken });
    expect((await adminHours(bistro)).weekly).toEqual(theirs.weekly); // not even part of it
    expect(await version()).toBe(v1);
    expect(await audits()).toBe(1);

    // The owner was told, and saves again: knowingly overwriting Monday too.
    expect(await saveWeeklyHours(bistro, theirs.weeklyToken, mine)).toEqual({ ok: true });
    expect((await adminHours(bistro)).weekly).toEqual(mine);
  });

  it("a stale form that changed nothing is not a conflict and writes nothing", async () => {
    const seen = await adminHours(bistro);
    await saveWeeklyHours(bistro, seen.weeklyToken, { ...seen.weekly, monday: null });
    const v1 = await version();
    expect(await saveWeeklyHours(bistro, seen.weeklyToken, seen.weekly)).toEqual({ ok: true, unchanged: true });
    expect((await adminHours(bistro)).weekly.monday).toBeNull();
    expect(await version()).toBe(v1);
  });

  it("two people saving the same week: the second is told nothing is left to change", async () => {
    const seen = await adminHours(bistro);
    const same = { ...seen.weekly, sunday: { open: "12:00", close: "16:00" } };
    expect(await saveWeeklyHours(bistro, seen.weeklyToken, same)).toEqual({ ok: true });
    expect(await saveWeeklyHours(bistro, seen.weeklyToken, same)).toEqual({ ok: true, unchanged: true });
    expect(await audits()).toBe(1);
  });

  it("a missing or tampered token is a conflict, not a blind write", async () => {
    const seen = await adminHours(bistro);
    const change = { ...seen.weekly, monday: null };
    for (const token of ["", "closed", "x,x,x,x,x,x,x", seen.weeklyToken.replace(/^[^,]+/, "25:00-22:00"), `${seen.weeklyToken},closed`]) {
      expect(await saveWeeklyHours(bistro, token, change)).toEqual({ ok: false, error: "conflict", current: seen.weeklyToken });
    }
    expect((await adminHours(bistro)).weekly).toEqual(seen.weekly);
    expect(await audits()).toBe(0);
  });

  it("a site with no stored week reads as closed, and the token matches it", async () => {
    const wa = ctx("westafrican");
    const empty = await adminHours(wa);
    expect(empty.weeklyToken).toBe(Array(7).fill("closed").join(","));
    expect(await saveWeeklyHours(wa, empty.weeklyToken, empty.weekly)).toEqual({ ok: true, unchanged: true });
    expect(await saveWeeklyHours(wa, empty.weeklyToken, { ...empty.weekly, friday: { open: "17:00", close: "23:00" } })).toEqual({ ok: true });
    expect((await adminHours(wa)).weekly.friday).toEqual({ open: "17:00", close: "23:00" });
  });

  it("only touches its own site", async () => {
    await saveWeeklyHours(ctx("westafrican"), (await adminHours(ctx("westafrican"))).weeklyToken, week({ open: "09:00", close: "10:00" }));
    expect((await adminHours(bistro)).weekly).toEqual(hours.weekly);
  });
});

describe("exceptions", () => {
  it("adds a closed day and a special-hours day, listed in date order", async () => {
    expect(await addException(bistro, christmas)).toEqual({ ok: true });
    expect(await addException(bistro, { date: "2026-12-31", hours: { open: "18:00", close: "02:00" }, note: { sv: "Nyårsafton", en: "New Year's Eve" } })).toEqual({ ok: true });
    expect((await adminHours(bistro)).exceptions.map((e) => [e.date, e.hours])).toEqual([
      ["2026-12-24", null],
      ["2026-12-31", { open: "18:00", close: "02:00" }],
    ]);
  });

  it("accepts today but not yesterday (Stockholm dates)", async () => {
    expect(await addException(bistro, { ...christmas, date: "2026-10-16" })).toEqual({ ok: true });
    expect(await addException(bistro, { ...christmas, date: "2026-10-15" })).toEqual({ ok: false, error: "past" });
  });

  it("accepts up to two years ahead and no further", async () => {
    expect(await addException(bistro, { ...christmas, date: "2028-10-16" })).toEqual({ ok: true });
    expect(await addException(bistro, { ...christmas, date: "2028-10-17" })).toEqual({ ok: false, error: "too-far" });
  });

  it("refuses a second exception on the same date", async () => {
    await addException(bistro, christmas);
    expect(await addException(bistro, { ...christmas, note: { sv: "Igen", en: "Again" } })).toEqual({ ok: false, error: "duplicate" });
  });

  it("rejects an impossible date, half-filled hours or a missing note", async () => {
    const result = await addException(bistro, { date: "2026-02-30", hours: { open: "", close: "22:00" }, note: { sv: "Stängt", en: " " } });
    expect(result.ok === false && result.error === "invalid" && result.issues.map((i) => i.path)).toEqual(["date", "hours.open", "note.en"]);
  });

  it("removes an exception, and is not-found for another site's", async () => {
    await addException(bistro, christmas);
    expect(await removeException(ctx("westafrican"), "2026-12-24")).toEqual({ ok: false, error: "not-found" });
    expect(await removeException(bistro, "2026-12-24")).toEqual({ ok: true });
    expect((await adminHours(bistro)).exceptions).toEqual([]);
  });
});
