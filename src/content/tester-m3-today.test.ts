/**
 * Tester (2026-10-16, ADR-011 plan M3.2): "today" edge cases beyond the builder's tests —
 * spring DST, year end, leap day, exceptions that open a closed day.
 */
import { describe, expect, it } from "vitest";
import type { OpeningHours } from "./load";
import { todayFor } from "./today";

const hours: OpeningHours = {
  weekly: {
    monday: null,
    tuesday: { open: "11:00", close: "22:00" },
    wednesday: { open: "11:00", close: "22:00" },
    thursday: { open: "11:00", close: "22:00" },
    friday: { open: "11:00", close: "23:00" },
    saturday: { open: "12:00", close: "23:00" },
    sunday: null,
  },
  exceptions: [
    { date: "2027-03-29", note: { sv: "Extra", en: "Extra" }, hours: { open: "17:00", close: "21:00" } }, // a Monday
    { date: "2028-02-29", note: { sv: "Skottdag", en: "Leap day" }, hours: { open: "10:00", close: "14:00" } },
    { date: "2027-01-01", note: { sv: "Nyårsdagen", en: "New Year's Day" }, hours: null },
  ],
};

describe("todayFor, spring DST (clocks go forward 2027-03-28 01:00 UTC)", () => {
  it("is still the 27th at 23:59 CET and the 28th at 00:00 CET", () => {
    expect(todayFor(hours, {}, new Date("2027-03-27T22:59:00Z")).date).toBe("2027-03-27");
    expect(todayFor(hours, {}, new Date("2027-03-27T23:00:00Z")).date).toBe("2027-03-28");
  });

  it("rolls to the 29th at 22:00 UTC on the 28th (00:00 CEST), clearing the 28th's sold-out", () => {
    const soldOutOn = { soup00000001: "2027-03-28" };
    expect(todayFor(hours, soldOutOn, new Date("2027-03-28T21:59:00Z")).soldOut).toEqual(["soup00000001"]);
    const next = todayFor(hours, soldOutOn, new Date("2027-03-28T22:00:00Z"));
    expect(next.date).toBe("2027-03-29");
    expect(next.soldOut).toEqual([]);
  });

  it("lets an exception open a day that is normally closed", () => {
    expect(todayFor(hours, {}, new Date("2027-03-29T10:00:00Z")).hours).toEqual({ open: "17:00", close: "21:00" });
  });
});

describe("todayFor, autumn DST repeated hour (2026-10-25 00:00–01:00 UTC is 02:00–03:00 twice)", () => {
  it("stays on the 25th through the repeated hour", () => {
    expect(todayFor(hours, {}, new Date("2026-10-25T00:30:00Z")).date).toBe("2026-10-25");
    expect(todayFor(hours, {}, new Date("2026-10-25T01:30:00Z")).date).toBe("2026-10-25");
    expect(todayFor(hours, {}, new Date("2026-10-24T21:59:59Z")).date).toBe("2026-10-24");
    expect(todayFor(hours, {}, new Date("2026-10-24T22:00:00Z")).date).toBe("2026-10-25");
  });
});

describe("todayFor, calendar edges", () => {
  it("crosses the year in Stockholm before UTC does, applying New Year's closure", () => {
    const t = todayFor(hours, { a: "2026-12-31" }, new Date("2026-12-31T23:00:00Z"));
    expect(t).toEqual({ date: "2027-01-01", hours: null, soldOut: [] });
  });

  it("handles a leap-day exception", () => {
    expect(todayFor(hours, {}, new Date("2028-02-29T12:00:00Z")).hours).toEqual({ open: "10:00", close: "14:00" });
    expect(todayFor(hours, {}, new Date("2028-02-28T23:30:00Z")).date).toBe("2028-02-29");
  });

  it("ignores sold-out dates with another format rather than matching them", () => {
    const t = todayFor(hours, { a: "2026-10-16T00:00:00Z", b: "16/10/2026", c: "2026-10-16" }, new Date("2026-10-16T10:00:00Z"));
    expect(t.soldOut).toEqual(["c"]);
  });
});
