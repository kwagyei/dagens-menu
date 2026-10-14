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
  };
  about: {
    story: LocalizedString;
    chef: LocalizedString;
  };
}

export interface Theme {
  colors: {
    primary: string;
    secondary: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
  };
  fonts: {
    heading: string;
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

export function getTheme(): Theme {
  return loadJson<Theme>("theme.json");
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
