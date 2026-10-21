import sv from "./sv";
import en from "./en";

const translations = { sv, en } as const;

type Locale = keyof typeof translations;
export type TranslationKey = keyof (typeof translations)["sv"];

export function t(locale: Locale, key: TranslationKey): string {
  return translations[locale]?.[key] ?? translations.sv[key] ?? key;
}

/**
 * A UI string with its {placeholders} filled in. The values go in as they are: a function
 * replacer, because String.replace reads "$&", "$'" and "$`" in a plain replacement string
 * as patterns, and owner text (a dish named "Pasta $' special") would come out garbled
 * (wrap-up review L4, 19 Oct). A placeholder with no value is left as it is.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

export function getLocale(url: URL): Locale {
  const [, segment] = url.pathname.split("/");
  return segment === "en" ? "en" : "sv";
}

export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return locale === "sv" ? clean : `/en${clean}`;
}
