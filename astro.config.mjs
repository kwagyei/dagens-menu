// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

const site = process.env.SITE || "bistro";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    define: {
      "import.meta.env.SITE_ID": JSON.stringify(site),
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
