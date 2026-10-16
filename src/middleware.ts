// Wires the request pipeline (src/server/handler.ts) to Astro and the Worker: content from
// D1 through one D1ContentSource per isolate, the theme and emergency details bundled at
// build time, and the site the build was made for. Admin routes are guarded first (origin,
// rate limit) and get the signed-in session.
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { guardAdminRequest } from "./auth/guard";
import { getSession, readCookie, SESSION_COOKIE } from "./auth/sessions";
import { bundledSettings, bundledTheme } from "./content/bundled";
import { D1ContentSource } from "./content/d1-source";
import { handlePage } from "./server/handler";
import { decodedPath, routeClass, securityHeaders } from "./server/http";

declare const __BUILD_SITE__: string;
declare const __BUILD_ID__: string;

// Kept for the life of the isolate: it holds the content until the version changes.
const sources = new Map<string, D1ContentSource>();
function source(site: string): D1ContentSource {
  let found = sources.get(site);
  if (!found) {
    found = new D1ContentSource(env.DB, site, bundledTheme(site));
    sources.set(site, found);
  }
  return found;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const admin = routeClass(context.url.pathname) === "admin";
  if (admin) {
    // Without a signing secret the admin can't work safely: refuse all of it, cleanly.
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      console.error("admin: SESSION_SECRET is not set (32+ characters); the admin is unavailable.");
      const api = /\/admin\/api\//.test(decodedPath(context.url.pathname));
      return new Response(api ? JSON.stringify({ error: "not-configured" }) : "The admin is not configured.", {
        status: 503,
        headers: { ...securityHeaders("admin"), "Content-Type": api ? "application/json" : "text/plain; charset=utf-8" },
      });
    }
    const refused = await guardAdminRequest(context.request, __BUILD_SITE__, env.AUTH_LIMITER);
    if (refused) return refused;
  }
  return handlePage(
    context.request,
    {
      runtimeSiteId: env.SITE_ID,
      buildSiteId: __BUILD_SITE__,
      buildId: __BUILD_ID__,
      source,
      emergencySettings: bundledSettings,
      now: () => new Date(),
    },
    async ({ content, today }) => {
      context.locals.content = content;
      context.locals.today = today;
      context.locals.session = admin
        ? await getSession(env.DB, __BUILD_SITE__, readCookie(context.request.headers.get("Cookie"), SESSION_COOKIE), new Date())
        : null;
      return next();
    },
  );
});
