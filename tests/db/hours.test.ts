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
    expect(await saveWeeklyHours(bistro, week({ open: "17:00", close: "01:00" }))).toEqual({ ok: true });
    expect((await adminHours(bistro)).weekly).toEqual(week({ open: "17:00", close: "01:00" }));
    expect(await version()).toBeGreaterThan(v0!);
    expect((await exportSite(db, "bistro"))?.content.hours.weekly.friday).toEqual({ open: "17:00", close: "01:00" });
  });

  it("rejects an impossible time or a day that opens and closes at once, and writes nothing", async () => {
    const bad = { ...week({ open: "11:00", close: "22:00" }), monday: { open: "25:00", close: "22:00" }, tuesday: { open: "11:00", close: "11:00" } };
    const result = await saveWeeklyHours(bistro, bad);
    expect(result.ok === false && result.error === "invalid" && result.issues.map((i) => i.path)).toEqual(["monday.open", "tuesday"]);
    expect((await adminHours(bistro)).weekly).toEqual(hours.weekly);
  });

  it("only touches its own site", async () => {
    await saveWeeklyHours(ctx("westafrican"), week({ open: "09:00", close: "10:00" }));
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
