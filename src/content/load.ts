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

/** Resolve highlight IDs like "lunch-0" to actual menu items */
export function resolveHighlights(menu: Menu, ids: string[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const id of ids) {
    const dashIdx = id.lastIndexOf("-");
    if (dashIdx === -1) continue;
    const catId = id.slice(0, dashIdx);
    const itemIdx = parseInt(id.slice(dashIdx + 1), 10);
    const category = menu.categories.find((c) => c.id === catId);
    if (category && category.items[itemIdx]) {
      items.push(category.items[itemIdx]);
    }
  }
  return items;
}

/** Get today's opening hours */
export function getTodayHours(hours: OpeningHours): DayHours | null {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const today = days[new Date().getDay()];

  // Check exceptions first
  const todayStr = new Date().toISOString().slice(0, 10);
  const exception = hours.exceptions.find((e) => e.date === todayStr);
  if (exception) return exception.hours;

  return hours.weekly[today] ?? null;
}

/** Format a price in minor units (ore) to SEK display string */
export function formatPrice(minorUnits: number): string {
  const kr = Math.floor(minorUnits / 100);
  const ore = minorUnits % 100;
  return ore === 0 ? `${kr} kr` : `${kr},${ore.toString().padStart(2, "0")} kr`;
}

/** Get localized string for a given locale */
export function localized(str: LocalizedString, locale: string): string {
  return locale === "en" ? str.en : str.sv;
}
