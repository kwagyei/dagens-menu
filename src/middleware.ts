// Wires the request pipeline (src/server/handler.ts) to Astro and the Worker: content from
// D1 through one D1ContentSource per isolate, the theme and emergency details bundled at
// build time, and the site the build was made for.
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { bundledSettings, bundledTheme } from "./content/bundled";
import { D1ContentSource } from "./content/d1-source";
import { handlePage } from "./server/handler";

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

export const onRequest = defineMiddleware((context, next) =>
  handlePage(
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
      return next();
    },
  ),
);
