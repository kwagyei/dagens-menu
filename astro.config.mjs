// @ts-check
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Each site is its own Worker build: SITE picks the theme, the curated images and the
// wrangler config; content comes from D1 at request time (ADR-011). `astro check` runs
// without a SITE and only needs a valid config, so it falls back to the bistro there.
const isBuild = process.argv.includes("build");
const site = process.env.SITE ?? (isBuild ? undefined : "bistro");
if (!site) throw new Error("SITE is not set. Run e.g. `SITE=bistro npm run build` (or npm run build:bistro).");
if (!/^[a-z0-9-]+$/.test(site)) throw new Error(`SITE "${site}" is not a valid site id.`);

export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough", configPath: `wrangler.${site}.jsonc` }),
  session: false,
  // Cross-site form posts get a 403 (on by default; stated because the admin relies on it).
  security: { checkOrigin: true },
  vite: {
    plugins: [tailwindcss()],
    // The site the build was made for; the Worker refuses to serve another (src/content/site-id.ts).
    // __BUILD_ID__ goes into every page's ETag, so a deploy that changes templates but not
    // content still invalidates what browsers hold.
    define: {
      __BUILD_SITE__: JSON.stringify(site),
      __BUILD_ID__: JSON.stringify((process.env.GITHUB_SHA ?? Date.now().toString(36)).slice(0, 12)),
    },
  },
  i18n: {
    defaultLocale: "sv",
    locales: ["sv", "en"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
