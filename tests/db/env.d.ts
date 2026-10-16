/// <reference types="@cloudflare/vitest-plugin/types" />

// Test-only bindings, merged into the Worker's Env (src/worker-env.d.ts).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
