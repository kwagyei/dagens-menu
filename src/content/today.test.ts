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
  exceptions: [{ date: "2026-12-24", note: { sv: "Julafton", en: "Christmas Eve" }, hours: null }],
};

describe("todayFor", () => {
  it("lists only the dishes sold out on the restaurant's date", () => {
    const soldOutOn = { soup00000001: "2026-10-16", fish00000001: "2026-10-15", cake00000001: "2026-10-17" };
    expect(todayFor(hours, soldOutOn, new Date("2026-10-16T10:00:00Z"))).toEqual({
      date: "2026-10-16",
      hours: { open: "11:00", close: "23:00" },
      soldOut: ["soup00000001"],
    });
  });

  it("rolls over at Stockholm midnight, not UTC midnight", () => {
    const soldOutOn = { soup00000001: "2026-10-16" };
    // 21:59 UTC is 23:59 in Stockholm (summer time): still the 16th.
    expect(todayFor(hours, soldOutOn, new Date("2026-10-16T21:59:00Z")).soldOut).toEqual(["soup00000001"]);
    // 22:00 UTC is 00:00 on the 17th: yesterday's sold-out has cleared, and it's Saturday.
    const next = todayFor(hours, soldOutOn, new Date("2026-10-16T22:00:00Z"));
    expect(next).toEqual({ date: "2026-10-17", hours: { open: "12:00", close: "23:00" }, soldOut: [] });
  });

  it("uses the winter offset after the clocks go back", () => {
    // 25 Oct 2026: Stockholm is UTC+1 from 01:00 UTC. 22:30 UTC on the 26th is 23:30 there.
    expect(todayFor(hours, {}, new Date("2026-10-26T22:30:00Z")).date).toBe("2026-10-26");
    expect(todayFor(hours, {}, new Date("2026-10-26T23:00:00Z")).date).toBe("2026-10-27");
  });

  it("applies the day's exception", () => {
    expect(todayFor(hours, {}, new Date("2026-12-24T12:00:00Z")).hours).toBeNull();
  });
});
