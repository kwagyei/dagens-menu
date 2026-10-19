// @ts-check
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { buildImageVariants } from "./scripts/image-variants.ts";

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
  integrations: [
    {
      // The curated photos' WebP sizes, made before every build and dev server (M6.9, ADR-015 §3).
      // In the config rather than an npm prebuild hook, because CI and the tests call astro directly.
      name: "image-variants",
      hooks: {
        "astro:config:setup": async ({ command, logger }) => {
          if (command === "build" || command === "dev") await buildImageVariants(site, (m) => logger.info(m));
        },
      },
    },
  ],
  vite: {
    plugins: [tailwindcss()],
    build: {
      // Astro inlines a small script that imports nothing. No page's CSP allows an inline
      // script (script-src 'self', public pages included since 19 Oct), so every component
      // script stays a file, or the browser blocks it. Other assets keep Vite's default
      // (undefined = 4 kB).
      assetsInlineLimit: (file) => (/\.astro_astro_type_script/.test(file) ? false : undefined),
    },
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
