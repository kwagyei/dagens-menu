// The Worker's bindings (wrangler.<site>.jsonc). Declared here rather than by loading the
// full Workers runtime types globally, which would clash with the DOM types (src/db/types.ts).
declare namespace Cloudflare {
  interface Env {
    DB: import("./db/types").D1Database;
    /** The site this Worker serves; must equal the SITE it was built for. */
    SITE_ID: string;
    /** Signs challenge cookies and form tokens (a Worker secret, never in the repo). */
    SESSION_SECRET?: string;
    /** Per-IP budget for sign-in and admin writes (ADR-011 §6). */
    AUTH_LIMITER?: import("./auth/guard").RateLimiter;
  }
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
