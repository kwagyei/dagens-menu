/**
 * Stockholm wall-clock arithmetic for the e2e helpers. No Playwright imports, so the unit
 * tests (tests/e2e-calendar.test.ts) can check it with fixed instants.
 */

/**
 * Milliseconds from `now` to the next midnight in Stockholm. Read off the wall clock, so on
 * the two days a year with 23 or 25 hours it is an hour out before the 02:00/03:00 shift;
 * after the shift, which is when midnight is near, it is exact.
 */
export function msToStockholmMidnight(now: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const sinceMidnight = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 + now.getUTCMilliseconds();
  return 86_400_000 - sinceMidnight;
}
