import sv from "./sv";
import en from "./en";

const translations = { sv, en } as const;

type Locale = keyof typeof translations;
export type TranslationKey = keyof (typeof translations)["sv"];

export function t(locale: Locale, key: TranslationKey): string {
  return translations[locale]?.[key] ?? translations.sv[key] ?? key;
}

export function getLocale(url: URL): Locale {
  const [, segment] = url.pathname.split("/");
  return segment === "en" ? "en" : "sv";
}

export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return locale === "sv" ? clean : `/en${clean}`;
}
