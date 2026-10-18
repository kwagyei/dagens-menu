/**
 * The calendar facts the e2e specs have to survive, proved with a fixed clock instead of
 * waiting for the right day (the Worker under Playwright has no clock override). Each case is
 * the day or time that broke, or would break, a spec that assumed otherwise.
 */
import { describe, expect, it } from "vitest";
import bistroHours from "../sites/bistro/content/hours.json";
import westafricanHours from "../sites/westafrican/content/hours.json";
import type { SiteContent } from "../src/content/schema";
import { handlePage, type PageState } from "../src/server/handler";
import { msToStockholmMidnight } from "./e2e/clock";

const HOURS = { bistro: bistroHours, westafrican: westafricanHours };

/** What the Worker calls "today" for a request at `at`: the date, the hours and the sold-out dishes. */
async function todayAt(site: keyof typeof HOURS, at: string, soldOutOn: Record<string, string> = {}): Promise<PageState["today"]> {
  let state: PageState | undefined;
  const content = { hours: HOURS[site] } as unknown as SiteContent;
  await handlePage(
    new Request("https://x.workers.dev/"),
    {
      runtimeSiteId: site,
      buildSiteId: site,
      buildId: "b1",
      source: () => ({ load: async () => ({ content, version: "1", stale: false, soldOutOn }) }),
      emergencySettings: () => {
        throw new Error("not reached");
      },
      now: () => new Date(at),
      log: () => {},
    },
    async (s) => ((state = s), new Response("ok")),
  );
  return state!.today;
}

describe("the weekday decides whether the badge and footer show a time range", () => {
  // tester-m6-prb-public.spec.ts:58 (fixed in #55) and tester-m5-hours.spec.ts:264 (7edf06f).
  it("the bistro is closed on a Sunday, so its badge says Stängt", async () => {
    expect((await todayAt("bistro", "2026-10-18T10:00:00Z")).hours).toBeNull();
  });

  it("Chez Abena is closed on a Monday, so its badge says Stängt", async () => {
    expect((await todayAt("westafrican", "2026-10-19T10:00:00Z")).hours).toBeNull();
  });

  it("on a Wednesday both show a time range", async () => {
    expect((await todayAt("bistro", "2026-10-21T10:00:00Z")).hours).toEqual({ open: "11:00", close: "22:00" });
    expect((await todayAt("westafrican", "2026-10-21T10:00:00Z")).hours).toEqual({ open: "12:00", close: "22:00" });
  });

  it("no weekday is closed on both sites, so a spec can't assume one state for every site", () => {
    const closed = (h: typeof bistroHours | typeof westafricanHours) =>
      Object.entries(h.weekly)
        .filter(([, v]) => v === null)
        .map(([d]) => d);
    expect(closed(bistroHours)).toEqual(["sunday"]);
    expect(closed(westafricanHours)).toEqual(["monday"]);
  });
});

describe("Stockholm midnight changes what a test set up a moment earlier", () => {
  // Saturday 23:59 and Sunday 00:01 in Stockholm (summer time, UTC+2).
  const before = "2026-10-17T21:59:00Z";
  const after = "2026-10-17T22:01:00Z";

  it("the badge goes from Saturday's hours to closed", async () => {
    expect((await todayAt("bistro", before)).hours).toEqual({ open: "12:00", close: "23:00" });
    expect((await todayAt("bistro", after)).hours).toBeNull();
  });

  it("a dish sold out at 23:59 is on sale again at 00:01, so a spec's undo button is gone", async () => {
    // menu.spec.ts, keyboard.spec.ts, history.spec.ts, tester-m5.spec.ts, tester-m5-history.spec.ts.
    const soldOutOn = { dish00000001: "2026-10-17" };
    expect((await todayAt("bistro", before, soldOutOn)).soldOut).toEqual(["dish00000001"]);
    expect((await todayAt("bistro", after, soldOutOn)).soldOut).toEqual([]);
  });

  it("an exception added for 'today' at 23:59 is yesterday's at 00:01", async () => {
    // tester-m5-hours.spec.ts: today's exception, the badge, and "+2 years exactly".
    expect((await todayAt("bistro", before)).date).toBe("2026-10-17");
    expect((await todayAt("bistro", after)).date).toBe("2026-10-18");
  });

  it("the nightly edge run (22:30 UTC) starts half an hour before midnight in winter", () => {
    // CET (UTC+1) from 25 October: 22:30 UTC is 23:30 in Stockholm.
    expect(msToStockholmMidnight(new Date("2026-11-03T22:30:00Z"))).toBe(30 * 60_000);
    // CEST (UTC+2): 22:30 UTC is already 00:30, so a summer run is clear of midnight.
    expect(msToStockholmMidnight(new Date("2026-07-03T22:30:00Z"))).toBe(23.5 * 3_600_000);
  });
});

describe("msToStockholmMidnight, which clearOfMidnight() waits on", () => {
  it("counts to Stockholm midnight, not UTC midnight", () => {
    expect(msToStockholmMidnight(new Date("2026-10-17T21:59:00Z"))).toBe(60_000);
    expect(msToStockholmMidnight(new Date("2026-10-17T21:59:59.250Z"))).toBe(750);
    expect(msToStockholmMidnight(new Date("2026-10-17T22:00:00Z"))).toBe(86_400_000);
  });

  it("is exact on the evenings of both clock changes", () => {
    // 25 Oct 2026, back to CET at 03:00: 23:58 that evening is 22:58 UTC.
    expect(msToStockholmMidnight(new Date("2026-10-25T22:58:00Z"))).toBe(120_000);
    // 29 Mar 2026, forward to CEST at 02:00: 23:58 that evening is 21:58 UTC.
    expect(msToStockholmMidnight(new Date("2026-03-29T21:58:00Z"))).toBe(120_000);
  });

  it("crosses month and year ends like any other midnight", () => {
    expect(msToStockholmMidnight(new Date("2026-12-31T22:59:30Z"))).toBe(30_000);
    expect(msToStockholmMidnight(new Date("2028-02-28T22:59:30Z"))).toBe(30_000);
  });
});
