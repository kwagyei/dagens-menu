import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the admin against a built Worker on wrangler dev, with a fresh local D1
// and a throwaway session secret (ADR-011 §13). The bistro by default; E2E_SITE=westafrican
// runs a spec against the other demo (CI does this for the accessibility spec, whose result
// depends on each site's colours).
//
// Two projects, split by what a test protects:
// - gate: the owner's journeys and the security model. CI's deploy job needs it, so it must
//   stay fast and deterministic (CI shards it across runners, about 5 minutes). `npm run test:e2e`.
// - edge: the tester's edge-case sweeps, named by behaviour with an .edge.spec.ts suffix. They run on every PR and nightly but
//   never block a deploy. `npm run test:e2e:edge`.
// No retries: a test that needs one is flaky, and a retry would hide it.
const EDGE = /\.edge\.spec\.ts$/;
const PORT = 8790;
const SITE = process.env.E2E_SITE ?? "bistro";
if (!/^[a-z]+$/.test(SITE)) throw new Error(`E2E_SITE must be a site id, got "${SITE}"`);
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
    // Safari is where iPhone owners upload: the encoder, canvas and DataTransfer path in WebKit
    // (plan M6.7). Non-blocking, with the edge suite.
    { name: "webkit", testMatch: /(photo-upload|browser-pipeline-images\.edge)\.spec\.ts$/, use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: [
      `SITE=${SITE} npx astro build`,
      "npm run -s db:migrate:local",
      `npm run -s seed -- --site ${SITE} --reset`,
      `npx wrangler dev --port ${PORT} --persist-to .wrangler/state --var SESSION_SECRET:${secret}`,
    ].join(" && "),
    url: `http://localhost:${PORT}/`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
