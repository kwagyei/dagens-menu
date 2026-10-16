/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    DB: import("../../src/db/types").D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

// Only the part of the Workers runtime module these tests use (the full runtime types are
// not loaded globally; see src/db/types.ts).
declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
