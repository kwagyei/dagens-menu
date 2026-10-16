// Helpers for rendering content. The content itself is loaded by src/middleware.ts into
// Astro.locals.content; its types are defined by the schema.
import type { DeepReadonly } from "./readonly";
import type * as Schema from "./schema";

// Read-only views of the schema's types: what templates and render helpers receive.
export type LocalizedString = DeepReadonly<Schema.LocalizedString>;
export type DayHours = DeepReadonly<Schema.DayHours>;
export type OpeningHours = DeepReadonly<Schema.OpeningHours>;
export type MenuItem = DeepReadonly<Schema.MenuItem>;
export type Menu = DeepReadonly<Schema.Menu>;
export type MenuCategory = DeepReadonly<Schema.MenuCategory>;
export type SiteSettings = DeepReadonly<Schema.SiteSettings>;
export type Pages = DeepReadonly<Schema.Pages>;
export type GalleryImage = DeepReadonly<Schema.GalleryImage>;
export type Gallery = DeepReadonly<Schema.Gallery>;
export type Theme = DeepReadonly<Schema.Theme>;

/**
 * Resolve the home page's highlight ids to menu items, in the order given. Unknown ids and
 * unavailable items are skipped, so a deleted or sold-out dish quietly drops off the home
 * page instead of breaking it. Each result keeps its id, for looking up its image.
 */
export function resolveHighlights(menu: Menu, ids: readonly string[]): Array<{ id: string; item: MenuItem }> {
  const byId = new Map(menu.categories.flatMap((c) => c.items.map((item) => [item.id, item] as const)));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item && item.available ? [{ id, item }] : [];
  });
}

/**
 * Format a price in minor units (öre) as a Swedish SEK string, e.g. 14500 → "145 kr",
 * 12550 → "125,50 kr", 125000 → "1 250 kr". Spaces are non-breaking so a price never
 * wraps mid-number. Throws on anything but a non-negative integer, so a bad CMS edit
 * fails the build instead of rendering "NaN kr".
 */
export function formatPrice(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new RangeError(`Price must be a non-negative integer in öre, got ${minorUnits}`);
  }
  const kr = Math.floor(minorUnits / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const ore = minorUnits % 100;
  return ore === 0 ? `${kr}\u00a0kr` : `${kr},${ore.toString().padStart(2, "0")}\u00a0kr`;
}

/** Get localized string for a given locale */
export function localized(str: LocalizedString, locale: string): string {
  return locale === "en" ? str.en : str.sv;
}
