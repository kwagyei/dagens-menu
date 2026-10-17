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

describe("e2e specs", () => {
  it("exist (so the rules below check something)", () => {
    expect(specs.length).toBeGreaterThan(5);
  });

  it("never take today's date in UTC: use stockholmToday() or daysAhead() from helpers.ts", () => {
    expect(offending(/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/)).toEqual([]);
  });

  it("never retry: a test that needs a retry is flaky, and the retry hides it", () => {
    expect(offending(/retries\s*:/)).toEqual([]);
  });

  it("never wait out the rate limit: use a fresh CF-Connecting-IP instead", () => {
    expect(offending(/waitForTimeout\(\s*[1-9]\d_?\d{3}/)).toEqual([]);
  });
});
