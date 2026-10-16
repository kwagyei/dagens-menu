/**
 * Per-site files bundled into the Worker at build time, so they never depend on D1: the
 * theme (developer-edited, ADR-011 §5) and the contact details for the emergency page shown
 * when the database is unreachable (§3).
 */
import type { SiteSettings, Theme } from "./schema";

const themes = import.meta.glob<Theme>("../../sites/*/theme.json", { eager: true, import: "default" });
const settings = import.meta.glob<SiteSettings>("../../sites/*/content/settings.json", { eager: true, import: "default" });

export function bundledTheme(site: string): Theme {
  const theme = themes[`../../sites/${site}/theme.json`];
  if (!theme) throw new Error(`No theme bundled for site "${site}".`);
  return theme;
}

/** The contact details the site was seeded with: good enough to reach the restaurant. */
export function bundledSettings(site: string): SiteSettings {
  const found = settings[`../../sites/${site}/content/settings.json`];
  if (!found) throw new Error(`No settings bundled for site "${site}".`);
  return found;
}
