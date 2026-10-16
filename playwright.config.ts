import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests of the admin against the built bistro Worker on wrangler dev, with a
// fresh local D1 and a throwaway session secret (ADR-011 §13).
const PORT = 8790;
const secret = randomBytes(32).toString("base64url");

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
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
