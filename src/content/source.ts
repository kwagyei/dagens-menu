/**
 * Where a site's content comes from. Pages and components never read content directly:
 * src/middleware.ts loads it through a ContentSource into Astro.locals.content, once per
 * request (once per page at build time).
 *
 * This module has no Node or platform imports, so it can be bundled anywhere. The Worker
 * reads D1 (d1-source.ts); the JSON source (json-source.ts, Node only) feeds the seed CLI
 * and tests.
 */
import type { SiteContent } from "./schema";

export interface LoadContext {
  /** The request's time: "today" for sold-out flags and opening hours is derived from it. */
  now: Date;
}

export interface LoadedContent {
  content: SiteContent;
  /** Changes whenever the content changes; the D1 source uses it for ETags. */
  version: string;
  /** True when the source served a cached copy because the store was unreachable. */
  stale: boolean;
  /** Dish id → the restaurant date it was marked sold out on (D1 only; see today.ts). */
  soldOutOn: Readonly<Record<string, string>>;
}

export interface ContentSource {
  load(ctx: LoadContext): Promise<LoadedContent>;
}
