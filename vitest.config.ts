import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 5's persistent module cache (on by default) breaks the workerd runner of
    // @cloudflare/vitest-plugin 1.4.2: it tries to read cache entries that were never written.
    fsModuleCache: false,
    projects: [
      {
        // Pure TypeScript: schema, parser, helpers, request pipeline, content files.
        test: {
          name: "node",
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: ["tests/db/**", "**/node_modules/**"],
        },
      },
      {
        // Database code, inside workerd against a local D1 with the real migrations applied.
        plugins: [
          cloudflareTest(async () => ({
            miniflare: {
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
              bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations") },
            },
          })),
        ],
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          setupFiles: ["tests/db/apply-migrations.ts"],
        },
      },
    ],
  },
});
