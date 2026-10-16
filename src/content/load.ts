import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const siteId = process.env.SITE || "bistro";
const sitesDir = resolve(process.cwd(), "sites", siteId);

function loadJson<T>(relativePath: string): T {
  const fullPath = resolve(sitesDir, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

export interface LocalizedString {
  sv: string;
  en: string;
}

export interface SiteSettings {
  name: LocalizedString;
  tagline: LocalizedString;
  cuisine: LocalizedString;
  address: string;
  phone: string;
  email: string;
  socialLinks: Record<string, string>;
  booking: { provider: string; embedCode?: string; bookingUrl?: string };
  mapEmbed: string;
}

export interface DayHours {
  open: string;
  close: string;
}

export interface OpeningHours {
  weekly: Record<string, DayHours | null>;
  exceptions: Array<{ date: string; note: LocalizedString; hours: DayHours | null }>;
}

export interface MenuItem {
  /** Stable id: highlights and the admin refer to items by it, never by position. */
  id: string;
  name: LocalizedString;
  description: LocalizedString;
  price: number;
  tags: string[];
  allergens: string[];
  available: boolean;
  image?: string;
}

export interface MenuCategory {
  id: string;
  name: LocalizedString;
  items: MenuItem[];
}

export interface Menu {
  categories: MenuCategory[];
}

export interface Pages {
  home: {
    tagline: LocalizedString;
    highlights: string[];
    heroImage?: string;
    highlightImages?: Record<string, string>;
    pullQuote?: LocalizedString;
    ctaImage?: string;
  };
  menu: {
    heroImage?: string;
  };
  about: {
    story: LocalizedString;
    chef: LocalizedString;
    storyImage?: string;
    kitchenImage?: string;
  };
}

export interface GalleryImage {
  src: string;
  alt: LocalizedString;
}

export interface Gallery {
  images: GalleryImage[];
}

export interface Theme {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    surfaceAlt: string;
    text: string;
    textMuted: string;
    border: string;
    heroBg: string;
    heroText: string;
    heroMuted: string;
  };
  fonts: {
    heading: string;
    display: string;
    body: string;
  };
  cornerRadius: string;
  heroStyle: string;
}

export function getSettings(): SiteSettings {
  return loadJson<SiteSettings>("content/settings.json");
}

export function getHours(): OpeningHours {
  return loadJson<OpeningHours>("content/hours.json");
}

export function getMenu(): Menu {
  return loadJson<Menu>("content/menu.json");
}

export function getPages(): Pages {
  return loadJson<Pages>("content/pages.json");
}

export function getGallery(): Gallery {
  return loadJson<Gallery>("content/gallery.json");
}

export function getTheme(): Theme {
  return loadJson<Theme>("theme.json");
}

/**
 * Resolve the home page's highlight ids to menu items, in the order given. Unknown ids and
 * unavailable items are skipped, so a deleted or sold-out dish quietly drops off the home
 * page instead of breaking it. Each result keeps its id, for looking up its image.
 */
export function resolveHighlights(menu: Menu, ids: string[]): Array<{ id: string; item: MenuItem }> {
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
