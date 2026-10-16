import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sitesDir = resolve(import.meta.dirname, "..", "sites");

/** A site's raw content files, shaped as the input to siteContentSchema. */
export function readSiteJson(site: string) {
  const read = (file: string) => JSON.parse(readFileSync(resolve(sitesDir, site, file), "utf-8"));
  return {
    settings: read("content/settings.json"),
    hours: read("content/hours.json"),
    menu: read("content/menu.json"),
    pages: read("content/pages.json"),
    gallery: read("content/gallery.json"),
    theme: read("theme.json"),
  };
}
