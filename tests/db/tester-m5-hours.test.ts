/** Tester, M5.4: attacks on opening hours and exceptions at the repository level (workerd + D1). */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import { hoursOn, restaurantDay } from "../../src/content/hours";
import { hoursSchema } from "../../src/content/schema";
import type { Weekday } from "../../src/content/vocabulary";
import { exportSite } from "../../src/db/export";
import { addException, adminHours, type Hours, removeException, saveWeeklyHours } from "../../src/db/hours";
import type { RepoContext } from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-16T08:00:00Z"); // Friday morning in Stockholm
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
  ({ monday: h, tuesday: h, wednesday: h, thursday: h, friday: h, saturday: h, sunday: h }) as Record<Weekday, Hours | null>;
const note = { sv: "Anledning", en: "Reason" };
const closedOn = (date: string, n = note) => ({ date, hours: null, note: n });
const version = (site = "bistro") => db.prepare("SELECT content_version FROM sites WHERE id = ?").bind(site).first<number>("content_version");
const audits = async (entity: string) =>
  (await db.prepare("SELECT * FROM audit_log WHERE entity = ? ORDER BY id").bind(entity).all<Record<string, string>>()).results;
const invalid = (r: unknown) => (r as { ok: false; error: string; issues?: Array<{ path: string }> });

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content, () => ({ id: "0".repeat(64), mime: "image/jpeg" }))));
  await db.prepare("INSERT INTO sites (id) VALUES ('westafrican')").run();
});

describe("weekly hours: odd but legal times", () => {
  it("accepts closing after midnight, and the exported content still validates", async () => {
    expect(await saveWeeklyHours(bistro, week({ open: "18:00", close: "01:00" }))).toEqual({ ok: true });
    const exported = await exportSite(db, "bistro");
    expect(hoursSchema.safeParse(exported?.content.hours).success).toBe(true);
    expect(exported?.content.hours.weekly.friday).toEqual({ open: "18:00", close: "01:00" });
  });

  it("accepts 00:00 as a closing time and 23:59 as an opening time", async () => {
    expect(await saveWeeklyHours(bistro, week({ open: "23:59", close: "00:00" }))).toEqual({ ok: true });
  });

  it.each(["24:00", "7:00", "07:00:00", "07.00", "", " 07:00", "07:60", "-1:00"])("rejects the time %j and writes nothing", async (bad) => {
    const v0 = await version();
    const result = invalid(await saveWeeklyHours(bistro, { ...week({ open: "10:00", close: "20:00" }), tuesday: { open: bad, close: "20:00" } }));
    expect(result.error).toBe("invalid");
    expect((await adminHours(bistro)).weekly).toEqual(hours.weekly);
    expect(await version()).toBe(v0);
    expect(await audits("hours")).toHaveLength(0);
  });

  it("rejects open == close for every day, naming each day", async () => {
    const result = invalid(await saveWeeklyHours(bistro, week({ open: "10:00", close: "10:00" })));
    expect(result.issues?.map((i) => i.path)).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
  });

  it("rejects extra properties on a day (strict object)", async () => {
    const weird = { ...week(null), monday: { open: "10:00", close: "11:00", admin: true } as unknown as Hours };
    expect(invalid(await saveWeeklyHours(bistro, weird)).error).toBe("invalid");
  });

  it("closes a day that is missing from the posted week, rather than keeping the old hours", async () => {
    // Documents behaviour: a partial object is treated as 'closed' for the absent days.
    const partial = { monday: { open: "10:00", close: "11:00" } } as unknown as Record<Weekday, Hours | null>;
    expect(await saveWeeklyHours(bistro, partial)).toEqual({ ok: true });
    const saved = (await adminHours(bistro)).weekly;
    expect(saved.monday).toEqual({ open: "10:00", close: "11:00" });
    expect(saved.tuesday).toBeNull();
  });

  it("writes one audit entry and one version bump per save, even for an unchanged week", async () => {
    const v0 = (await version())!;
    await saveWeeklyHours(bistro, hours.weekly as Record<Weekday, Hours | null>);
    expect(await version()).toBeGreaterThan(v0); // triggers fire per row; only "moved forward" matters
    expect(await audits("hours")).toHaveLength(1);
  });

  it("does not touch the other site, in either direction", async () => {
    await saveWeeklyHours(ctx("westafrican"), week({ open: "09:00", close: "10:00" }));
    await saveWeeklyHours(bistro, week(null));
    expect((await adminHours(ctx("westafrican"))).weekly.monday).toEqual({ open: "09:00", close: "10:00" });
    expect(await version("westafrican")).toBeGreaterThan(0);
    const wa = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = 'westafrican'").first<number>("n");
    expect(wa).toBe(1);
  });
});

describe("exceptions and the Stockholm date boundary", () => {
  // Summer time is UTC+2 until 2026-10-25, winter time UTC+1 after.
  it("treats 23:59 Stockholm on the 16th as the 16th, and 00:00 on the 17th as the 17th (summer time)", async () => {
    const late = ctx("bistro", new Date("2026-10-16T21:59:00Z"));
    expect(restaurantDay(late.now).date).toBe("2026-10-16");
    expect(await addException(late, closedOn("2026-10-16"))).toEqual({ ok: true });
    const after = ctx("bistro", new Date("2026-10-16T22:00:00Z"));
    expect(restaurantDay(after.now).date).toBe("2026-10-17");
    expect(await addException(after, closedOn("2026-10-16", { sv: "Igår", en: "Yesterday" }))).toEqual({ ok: false, error: "past" });
    expect(await addException(after, closedOn("2026-10-15"))).toEqual({ ok: false, error: "past" });
  });

  it("does the same in winter time, where the offset is one hour", async () => {
    const edge = ctx("bistro", new Date("2026-12-15T22:59:00Z")); // 23:59 on the 15th
    expect(await addException(edge, closedOn("2026-12-15"))).toEqual({ ok: true });
    const next = ctx("bistro", new Date("2026-12-15T23:00:00Z")); // 00:00 on the 16th
    expect(await addException(next, closedOn("2026-12-15", { sv: "x", en: "x" }))).toEqual({ ok: false, error: "past" });
    expect(await addException(next, closedOn("2026-12-14"))).toEqual({ ok: false, error: "past" });
  });

  it("uses Stockholm's date, not UTC, just after local midnight", async () => {
    // 22:30Z on the 15th is 00:30 on the 16th in Stockholm: the 15th is already past.
    const c = ctx("bistro", new Date("2026-10-15T22:30:00Z"));
    expect(await addException(c, closedOn("2026-10-15"))).toEqual({ ok: false, error: "past" });
    expect(await addException(c, closedOn("2026-10-16"))).toEqual({ ok: true });
  });

  it("allows exactly +2 years and refuses the day after, on and around leap days", async () => {
    expect(await addException(bistro, closedOn("2028-10-16"))).toEqual({ ok: true });
    expect(await addException(bistro, closedOn("2028-10-17"))).toEqual({ ok: false, error: "too-far" });
    // Today is 29 Feb 2028: +2 years is 28 Feb 2030, and 1 Mar 2030 is too far.
    const leap = ctx("bistro", new Date("2028-02-29T10:00:00Z"));
    expect(await addException(leap, closedOn("2030-02-28"))).toEqual({ ok: true });
    expect(await addException(leap, closedOn("2030-03-01"))).toEqual({ ok: false, error: "too-far" });
    // Today is 28 Feb 2026: 29 Feb 2028 is one day past +2 years.
    const feb = ctx("bistro", new Date("2026-02-28T10:00:00Z"));
    expect(await addException(feb, closedOn("2028-02-28"))).toEqual({ ok: true });
    expect(await addException(feb, closedOn("2028-02-29"))).toEqual({ ok: false, error: "too-far" });
  });

  it("accepts 29 Feb on a leap year and rejects it on others", async () => {
    expect(await addException(bistro, closedOn("2028-02-29"))).toEqual({ ok: true });
    const r = invalid(await addException(bistro, closedOn("2027-02-29")));
    expect(r.error).toBe("invalid");
  });

  it.each(["", "2026-13-01", "2026-00-10", "2026-1-5", "26-10-16", "2026-10-16T00:00", "2026/10/16", " 2026-10-20", "2026-10-20 ", "٢٠٢٦-١٠-٢٠", "1999-12-31", "2100-01-01"])(
    "rejects the date %j without writing",
    async (date) => {
      const v0 = await version();
      const r = invalid(await addException(bistro, closedOn(date)));
      expect(["invalid", "past", "too-far"]).toContain(r.error);
      expect((await adminHours(bistro)).exceptions).toEqual([]);
      expect(await version()).toBe(v0);
    },
  );

  it("handles the 2099 ceiling without throwing", async () => {
    const far = ctx("bistro", new Date("2098-06-01T10:00:00Z"));
    expect(await addException(far, closedOn("2099-12-31"))).toEqual({ ok: true });
    expect(invalid(await addException(far, closedOn("2100-01-01"))).error).toBe("invalid");
  });
});

describe("exceptions: duplicates, double submits, removal", () => {
  it("two simultaneous adds of the same date: one wins, one is a duplicate, one audit entry", async () => {
    const v0 = (await version())!;
    const results = await Promise.all([addException(bistro, closedOn("2026-12-24")), addException(bistro, closedOn("2026-12-24", { sv: "b", en: "b" }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "duplicate" }]);
    expect((await adminHours(bistro)).exceptions).toHaveLength(1);
    expect(await version()).toBe(v0 + 1);
    expect(await audits("hours_exception")).toHaveLength(1);
  });

  it("a duplicate leaves the first exception's hours and note untouched", async () => {
    await addException(bistro, { date: "2026-12-24", hours: { open: "10:00", close: "14:00" }, note: { sv: "Första", en: "First" } });
    await addException(bistro, closedOn("2026-12-24", { sv: "Andra", en: "Second" }));
    expect((await adminHours(bistro)).exceptions[0]).toEqual({ date: "2026-12-24", hours: { open: "10:00", close: "14:00" }, note: { sv: "Första", en: "First" } });
  });

  it("the same date may exist on both sites", async () => {
    expect(await addException(bistro, closedOn("2026-12-24"))).toEqual({ ok: true });
    expect(await addException(ctx("westafrican"), closedOn("2026-12-24"))).toEqual({ ok: true });
  });

  it("two simultaneous removals: one ok, one not-found, one audit entry", async () => {
    await addException(bistro, closedOn("2026-12-24"));
    const results = await Promise.all([removeException(bistro, "2026-12-24"), removeException(bistro, "2026-12-24")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "not-found" }]);
    expect((await audits("hours_exception")).filter((a) => a.action === "delete")).toHaveLength(1);
  });

  it.each(["", "garbage", "2026-12-24' OR '1'='1", "2026-12-2", "%", "2026-12-24\u0000"])("removing %j is not-found, deletes nothing, no version bump", async (d) => {
    await addException(bistro, closedOn("2026-12-24"));
    const v0 = await version();
    expect(await removeException(bistro, d)).toEqual({ ok: false, error: "not-found" });
    expect((await adminHours(bistro)).exceptions).toHaveLength(1);
    expect(await version()).toBe(v0);
  });

  it("removing another site's date is not-found and leaves it in place", async () => {
    await addException(ctx("westafrican"), closedOn("2026-12-24"));
    expect(await removeException(bistro, "2026-12-24")).toEqual({ ok: false, error: "not-found" });
    expect((await adminHours(ctx("westafrican"))).exceptions).toHaveLength(1);
  });

  it("an exception can be removed and the date re-added", async () => {
    await addException(bistro, closedOn("2026-12-24"));
    await removeException(bistro, "2026-12-24");
    expect(await addException(bistro, closedOn("2026-12-24"))).toEqual({ ok: true });
  });
});

describe("exception notes and hours", () => {
  it("accepts a note of exactly 300 characters and rejects 301", async () => {
    expect(await addException(bistro, closedOn("2026-12-24", { sv: "å".repeat(300), en: "e".repeat(300) }))).toEqual({ ok: true });
    const r = invalid(await addException(bistro, closedOn("2026-12-25", { sv: "å".repeat(301), en: "e" })));
    expect(r).toMatchObject({ error: "invalid" });
    expect(r.issues?.map((i) => i.path)).toEqual(["note.sv"]);
  });

  it("counts an emoji as one character, not two", async () => {
    expect(await addException(bistro, closedOn("2026-12-24", { sv: "🎄".repeat(300), en: "x" }))).toEqual({ ok: true });
  });

  it.each([" ", "\n\t", "​", "‮", "­⁠"])("rejects a note of only whitespace or invisible characters %j", async (n) => {
    const r = invalid(await addException(bistro, closedOn("2026-12-24", { sv: n, en: "ok" })));
    expect(r.error).toBe("invalid");
    expect((await adminHours(bistro)).exceptions).toEqual([]);
  });

  it("strips invisible characters (bidi override) from a stored note", async () => {
    await addException(bistro, closedOn("2026-12-24", { sv: "Jul‮afton", en: "Xmas" }));
    expect((await adminHours(bistro)).exceptions[0].note.sv).toBe("Julafton");
  });

  it("stores markup as text; it is not interpreted by the repository", async () => {
    await addException(bistro, closedOn("2026-12-24", { sv: "<script>alert(1)</script>", en: "x" }));
    expect((await adminHours(bistro)).exceptions[0].note.sv).toBe("<script>alert(1)</script>");
  });

  it("allows special hours that close after midnight, and the public lookup uses them", async () => {
    await addException(bistro, { date: "2026-12-31", hours: { open: "18:00", close: "02:00" }, note: { sv: "Nyår", en: "NYE" } });
    const exported = (await exportSite(db, "bistro"))!.content.hours;
    expect(hoursOn(exported, new Date("2026-12-31T12:00:00Z"))).toEqual({ open: "18:00", close: "02:00" });
  });

  it("rejects open == close, a half-filled day and null-ish junk for an exception", async () => {
    for (const h of [{ open: "10:00", close: "10:00" }, { open: "10:00", close: "" }, { open: "", close: "" }]) {
      expect(invalid(await addException(bistro, { date: "2026-12-24", hours: h, note }) ).error).toBe("invalid");
    }
    expect((await adminHours(bistro)).exceptions).toEqual([]);
  });
});

describe("what the public site sees after the write", () => {
  it("a closed exception today overrides the weekly hours, other days do not", async () => {
    await addException(bistro, closedOn("2026-10-16"));
    const pub = (await exportSite(db, "bistro"))!.content.hours;
    expect(hoursOn(pub, now)).toBeNull();
    expect(hoursOn(pub, new Date("2026-10-17T10:00:00Z"))).toEqual(hours.weekly.saturday);
  });

  it("an exception dated today overrides after Stockholm midnight even though UTC is still yesterday", async () => {
    await addException(bistro, closedOn("2026-10-16"));
    const pub = (await exportSite(db, "bistro"))!.content.hours;
    expect(hoursOn(pub, new Date("2026-10-15T22:30:00Z"))).toBeNull();
    expect(hoursOn(pub, new Date("2026-10-15T21:59:00Z"))).toEqual(hours.weekly.thursday);
  });

  it("a rewritten week reaches the export and nothing else changes", async () => {
    const before = (await exportSite(db, "bistro"))!.content;
    await saveWeeklyHours(bistro, week({ open: "18:00", close: "01:00" }));
    const after = (await exportSite(db, "bistro"))!.content;
    expect(after.menu).toEqual(before.menu);
    expect(after.settings).toEqual(before.settings);
    expect(after.hours.weekly.sunday).toEqual({ open: "18:00", close: "01:00" });
  });

  it("past exceptions stay in the public list until removed (they never expire)", async () => {
    // The admin can't add past dates, but time passes after adding one.
    await addException(bistro, closedOn("2026-10-16"));
    const later = new Date("2026-11-20T10:00:00Z");
    const pub = (await exportSite(db, "bistro"))!.content.hours;
    expect(pub.exceptions.map((e) => e.date)).toContain("2026-10-16");
    expect(hoursOn(pub, later)).toEqual(hours.weekly.friday); // 20 Nov is a Friday: back to the weekly hours
  });

  it("after midnight: Friday 18:00-01:00 is not 'open' at 00:30 on Saturday in the today lookup (it reads Saturday's row)", async () => {
    // Characterisation, not an endorsement: hoursOn works per calendar day, so the Friday tail
    // after midnight is invisible. See the report (low).
    await saveWeeklyHours(bistro, { ...week(null), friday: { open: "18:00", close: "01:00" } });
    const pub = (await exportSite(db, "bistro"))!.content.hours;
    expect(hoursOn(pub, new Date("2026-10-16T22:30:00Z"))).toBeNull(); // Sat 00:30 Stockholm
    expect(hoursOn(pub, new Date("2026-10-16T17:00:00Z"))).toEqual({ open: "18:00", close: "01:00" }); // Fri 19:00
  });
});
