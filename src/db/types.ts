// D1 types, imported as a module rather than loading the Workers runtime types globally,
// which would clash with the DOM types the Astro pages use.
export type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types/index.ts";
