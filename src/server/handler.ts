/**
 * The request pipeline around every rendered page, kept free of Astro and Worker imports so
 * it can be tested directly (src/middleware.ts wires it up):
 *
 * 1. Check the Worker serves the site it was built for; otherwise 500, logged.
 * 2. Load the content; if the database is down and nothing is held, the emergency page (503).
 * 3. Answer 304 when the browser already has this version for today, without rendering.
 * 4. Otherwise render, then add the security, caching and ETag headers.
 */
import type { SiteSettings } from "../content/schema";
import type { SiteContent } from "../content/schema";
import { checkSiteId } from "../content/site-id";
import type { ContentSource } from "../content/source";
import { type Today, todayFor } from "../content/today";
import { emergencyPage } from "./emergency";
import { etagFor, isNotModified, routeClass, securityHeaders } from "./http";

export interface PageState {
  content: SiteContent;
  today: Today;
}

export interface HandlerDeps {
  /** The Worker's SITE_ID binding. */
  runtimeSiteId: string | undefined;
  /** The site baked into this build. */
  buildSiteId: string;
  buildId: string;
  source: (site: string) => ContentSource;
  /** Contact details for the emergency page, bundled at build time. */
  emergencySettings: (site: string) => SiteSettings;
  now: () => Date;
  log?: (message: string) => void;
}

export async function handlePage(
  request: Request,
  deps: HandlerDeps,
  render: (state: PageState) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeClass(url.pathname);
  const headers = securityHeaders(route);
  const log = deps.log ?? ((m: string) => console.error(m));

  let site: string;
  try {
    site = checkSiteId(deps.runtimeSiteId, deps.buildSiteId);
  } catch (error) {
    log(`site: ${(error as Error).message}`);
    return new Response("Misconfigured site", { status: 500, headers: { ...headers, "Cache-Control": "no-store" } });
  }

  const now = deps.now();
  let loaded;
  try {
    loaded = await deps.source(site).load({ now });
  } catch (error) {
    log(`content: unavailable for "${site}": ${(error as Error).message}`);
    const locale = url.pathname === "/en" || url.pathname.startsWith("/en/") ? "en" : "sv";
    return new Response(emergencyPage(deps.emergencySettings(site), locale), {
      status: 503,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }

  const today = todayFor(loaded.content.hours, loaded.soldOutOn, now);
  const etag = etagFor(loaded.version, today.date, deps.buildId);
  const extra: Record<string, string> = loaded.stale ? { "X-Content-Stale": "1" } : {};

  // A stale copy is never confirmed as current, and the admin is never cached.
  if (route === "public" && !loaded.stale && (request.method === "GET" || request.method === "HEAD") && isNotModified(request, etag)) {
    return new Response(null, { status: 304, headers: { ...headers, ETag: etag } });
  }

  const response = await render({ content: loaded.content, today });
  for (const [name, value] of Object.entries({ ...headers, ...extra })) response.headers.set(name, value);
  if (route === "public" && !loaded.stale && response.status === 200) response.headers.set("ETag", etag);
  return response;
}
