import { describe, expect, it } from "vitest";
import { dayAndMonth, hoursOn, restaurantDay, upcomingExceptions, weekRuns } from "./hours";
import type { OpeningHours } from "./load";

const hours: OpeningHours = {
  weekly: {
    monday: null,
    tuesday: { open: "11:00", close: "22:00" },
    wednesday: { open: "11:00", close: "22:00" },
    thursday: { open: "11:00", close: "22:00" },
    friday: { open: "11:00", close: "01:00" },
    saturday: { open: "12:00", close: "01:00" },
    sunday: { open: "12:00", close: "20:00" },
  },
  exceptions: [
    { date: "2026-12-24", note: { sv: "Julafton", en: "Christmas Eve" }, hours: null },
    { date: "2026-12-31", note: { sv: "Nyårsafton", en: "New Year's Eve" }, hours: { open: "18:00", close: "02:00" } },
  ],
};

describe("restaurantDay", () => {
  it("uses the Stockholm calendar day, not UTC", () => {
    // 23:30 UTC on Monday 2026-10-19 is already 01:30 on Tuesday in Stockholm (CEST, UTC+2).
    expect(restaurantDay(new Date("2026-10-19T23:30:00Z"))).toEqual({ date: "2026-10-20", weekday: "tuesday" });
  });

  it("follows the switch from summer to winter time", () => {
    // After 25 Oct 2026 Stockholm is UTC+1: 23:30 UTC is 00:30 the next day.
    expect(restaurantDay(new Date("2026-10-26T23:30:00Z"))).toEqual({ date: "2026-10-27", weekday: "tuesday" });
    // 22:30 UTC is still 23:30 the same day.
    expect(restaurantDay(new Date("2026-10-26T22:30:00Z"))).toEqual({ date: "2026-10-26", weekday: "monday" });
  });

  it("does not depend on the time zone of the machine running it", () => {
    const fromUtc = restaurantDay(new Date(Date.UTC(2026, 0, 1, 23, 30)));
    expect(fromUtc).toEqual({ date: "2026-01-02", weekday: "friday" });
  });
});

describe("hoursOn", () => {
  it("returns the weekly hours for an ordinary day", () => {
    expect(hoursOn(hours, new Date("2026-10-20T10:00:00Z"))).toEqual({ open: "11:00", close: "22:00" });
  });

  it("returns null on a weekly closed day", () => {
    expect(hoursOn(hours, new Date("2026-10-19T10:00:00Z"))).toBeNull();
  });

  it("lets an exception close a normally open day", () => {
    // Christmas Eve 2026 is a Thursday.
    expect(hoursOn(hours, new Date("2026-12-24T10:00:00Z"))).toBeNull();
  });

  it("lets an exception change the hours", () => {
    expect(hoursOn(hours, new Date("2026-12-31T10:00:00Z"))).toEqual({ open: "18:00", close: "02:00" });
  });

  it("matches exceptions on the Stockholm date near midnight", () => {
    // 23:30 UTC on 23 Dec is 00:30 on Christmas Eve in Stockholm.
    expect(hoursOn(hours, new Date("2026-12-23T23:30:00Z"))).toBeNull();
  });

  it("treats a missing weekday as closed", () => {
    // Invalid per the schema, but the badge must still not throw on it.
    const partial = { weekly: {}, exceptions: [] } as unknown as OpeningHours;
    expect(hoursOn(partial, new Date("2026-10-20T10:00:00Z"))).toBeNull();
  });
});

describe("upcomingExceptions", () => {
  it("keeps today and later, earliest first", () => {
    const reversed = { ...hours, exceptions: [...hours.exceptions].reverse() };
    expect(upcomingExceptions(reversed, "2026-12-01").map((e) => e.date)).toEqual(["2026-12-24", "2026-12-31"]);
    expect(upcomingExceptions(hours, "2026-12-24").map((e) => e.date)).toEqual(["2026-12-24", "2026-12-31"]);
    expect(upcomingExceptions(hours, "2026-12-25").map((e) => e.date)).toEqual(["2026-12-31"]);
    expect(upcomingExceptions(hours, "2027-01-01")).toEqual([]);
  });
});

describe("dayAndMonth", () => {
  it("names the day the way guests say it, whatever the server's time zone", () => {
    expect(dayAndMonth("2026-12-24", "sv")).toBe("24 december");
    expect(dayAndMonth("2026-12-24", "en")).toBe("24 December");
    expect(dayAndMonth("2027-01-01", "sv")).toBe("1 januari");
  });
});

describe("weekRuns", () => {
  const open = (o: string, c: string) => ({ open: o, close: c });
  it("groups consecutive days with the same hours, a closed day included", () => {
    expect(
      weekRuns({
        monday: null,
        tuesday: open("12:00", "22:00"),
        wednesday: open("12:00", "22:00"),
        thursday: open("12:00", "22:00"),
        friday: open("12:00", "23:00"),
        saturday: open("12:00", "23:00"),
        sunday: open("13:00", "20:00"),
      }),
    ).toEqual([
      { first: "monday", last: "monday", hours: null },
      { first: "tuesday", last: "thursday", hours: open("12:00", "22:00") },
      { first: "friday", last: "saturday", hours: open("12:00", "23:00") },
      { first: "sunday", last: "sunday", hours: open("13:00", "20:00") },
    ]);
  });

  it("makes one run of a week with the same hours every day, and of a week closed every day", () => {
    const every = (h: { open: string; close: string } | null) =>
      Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, h]));
    expect(weekRuns(every(open("11:00", "22:00")) as never)).toEqual([{ first: "monday", last: "sunday", hours: open("11:00", "22:00") }]);
    expect(weekRuns(every(null) as never)).toEqual([{ first: "monday", last: "sunday", hours: null }]);
  });

  it("doesn't join days with the same hours that aren't next to each other", () => {
    const runs = weekRuns({ monday: open("12:00", "22:00"), tuesday: null, wednesday: open("12:00", "22:00"), thursday: null, friday: null, saturday: null, sunday: null });
    expect(runs.map((r) => [r.first, r.last])).toEqual([
      ["monday", "monday"],
      ["tuesday", "tuesday"],
      ["wednesday", "wednesday"],
      ["thursday", "sunday"],
    ]);
  });
});
