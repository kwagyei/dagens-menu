import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the admin against the built bistro Worker on wrangler dev, with a
// fresh local D1 and a throwaway session secret (ADR-011 §13).
//
// Two projects, split by what a test protects:
// - gate: the owner's journeys and the security model. CI's deploy job needs it, so it must
//   stay fast (under 5 minutes) and deterministic. `npm run test:e2e`.
// - edge: the tester's edge-case sweeps (tester-m5-*). They run on every PR and nightly but
//   never block a deploy. `npm run test:e2e:edge`.
// No retries: a test that needs one is flaky, and a retry would hide it.
const EDGE = /tester-m5.*\.spec\.ts$/;
const PORT = 8790;
const secret = randomBytes(32).toString("base64url");

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "gate", testIgnore: EDGE, use: { ...devices["Pixel 7"] } },
    { name: "edge", testMatch: EDGE, use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: [
      "SITE=bistro npx astro build",
      "npm run -s db:migrate:local",
      "npm run -s seed -- --site bistro --reset",
      `npx wrangler dev --port ${PORT} --persist-to .wrangler/state --var SESSION_SECRET:${secret}`,
    ].join(" && "),
    url: `http://localhost:${PORT}/`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
