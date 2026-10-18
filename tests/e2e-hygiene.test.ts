/**
 * Rules for the Playwright specs that a reviewer would otherwise have to remember (review H1,
 * 2026-10-17). Each one caused a red or slow deploy gate once.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./e2e/", import.meta.url);
const specs = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: readFileSync(new URL(f, dir), "utf-8") }));

const offending = (pattern: RegExp) => specs.filter((s) => pattern.test(s.text)).map((s) => s.file);

/** file:line for each line that matches `pattern` but not `allowed`. */
const offendingLines = (pattern: RegExp, allowed: RegExp) =>
  specs.flatMap((s) =>
    s.text
      .split("\n")
      .map((line, i) => ({ line, at: `${s.file}:${i + 1}` }))
      .filter(({ line }) => pattern.test(line) && !allowed.test(line))
      .map(({ at }) => at),
  );

describe("test file names", () => {
  // Named by what they test, not by who wrote them (review L5). An edge-case sweep ends in
  // .edge.spec.ts, which is what sends it to the non-blocking edge project (playwright.config.ts).
  const names = ["tests", "tests/db", "tests/e2e", "src/server"].flatMap((d) => readdirSync(d).map((f) => `${d}/${f}`));
  it("never start with tester-", () => {
    expect(names.filter((n) => /\/tester-/.test(n) && /^(tests\/(db|e2e)|src\/server)\//.test(n))).toEqual([]);
  });

  it("route every spec to exactly one of gate and edge by its suffix alone", () => {
    const specs = names.filter((n) => n.startsWith("tests/e2e/") && n.endsWith(".spec.ts"));
    expect(specs.filter((n) => n.endsWith(".edge.spec.ts")).length).toBeGreaterThan(10);
    expect(specs.filter((n) => /edge/.test(n.split("/").pop()!) && !n.endsWith(".edge.spec.ts"))).toEqual([]);
  });
});

describe("e2e specs", () => {
  it("exist (so the rules below check something)", () => {
    expect(specs.length).toBeGreaterThan(5);
  });

  it("never take today's date in UTC: use stockholmToday() or daysAhead() from helpers.ts", () => {
    expect(offending(/toISOString\(\)\s*\.\s*(slice|substring)\(\s*0\s*,\s*10\s*\)/)).toEqual([]);
  });

  it("never retry: a test that needs a retry is flaky, and the retry hides it", () => {
    expect(offending(/retries\s*:/)).toEqual([]);
  });

  it("never wait out the rate limit: use freshIp() from helpers.ts instead", () => {
    expect(offending(/waitForTimeout\(\s*([1-9]\d_?\d{3}|\d+\s*\*\s*1_?000)/)).toEqual([]);
  });

  it("take client addresses from freshIp(), so specs can't share one and trip the rate limit", () => {
    expect(offending(/CF-Connecting-IP["']?\s*:\s*`/)).toEqual([]);
  });

  it("never expect today's hours to be a time range: every day is closed on some site (bistro Sunday, Chez Abena Monday)", () => {
    // public-layout-regressions.edge.spec.ts asserted "Idag: 12:00–22:00"-shaped text and failed on a Sunday (#55).
    expect(offendingLines(/(Idag|Today):[^\n]*(\d\d:\d\d|\\d)/, /Stängt|Closed/)).toEqual([]);
  });

  it("a spec that means 'today' across requests waits out midnight with clearOfMidnight() from helpers.ts", () => {
    // Sold out, today's exceptions and the home badge are all per Stockholm date; the nightly
    // edge run starts at 23:30 Stockholm time in winter.
    const today = /stockholmToday\(|Slutsåld idag|Sold out today|admin\.menu\.soldOut|hours-badge/;
    expect(specs.filter((s) => s.file.endsWith(".spec.ts") && today.test(s.text) && !/test\.beforeEach\(clearOfMidnight\)/.test(s.text)).map((s) => s.file)).toEqual([]);
  });
});
