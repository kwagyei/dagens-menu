import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_SECRET, usableSecret } from "./secret";

describe("usableSecret (security review L2)", () => {
  it("refuses the placeholder that .dev.vars.example ships", () => {
    const example = /^SESSION_SECRET=(.*)$/m.exec(readFileSync(".dev.vars.example", "utf-8"))![1];
    expect(example).toBe(PLACEHOLDER_SECRET);
    expect(example.length).toBeGreaterThanOrEqual(32);
    expect(usableSecret(example)).toBe(false);
    expect(usableSecret(` ${example} `)).toBe(false);
  });

  it("refuses a missing or short secret, and accepts 32 random characters", () => {
    expect(usableSecret(undefined)).toBe(false);
    expect(usableSecret("x".repeat(31))).toBe(false);
    expect(usableSecret("Zq3v9-ErT0bWm7Xk2LpYh8NcUa4sDf6G")).toBe(true);
  });
});
