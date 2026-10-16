/**
 * Turning posted admin forms into edits (ADR-011 §8, plan M5.2). Pure: no database, no
 * Astro, so every rule is unit-tested. A form either yields a clean edit or field-by-field
 * errors in the owner's language, and always keeps exactly what was typed, so a rejected
 * form comes back filled in.
 *
 * The repository validates again with the content schema; these checks are the friendly
 * first line, worded for owners rather than developers.
 */
import { cleanText, TEXT_LIMITS, visibleLength } from "../content/schema";
import { parseKronor, type PriceError } from "../content/price";
import { ALLERGENS, MENU_TAGS } from "../content/vocabulary";
import type { MenuItemEdit } from "../db/repository";
import { t } from "../i18n";

type Locale = "sv" | "en";

/** Below or above these, a price needs an explicit "yes, that's right" (a typo guard). */
export const PLAUSIBLE_PRICE_ORE = { min: 10 * 100, max: 2000 * 100 } as const;

export interface ItemFormValues {
  name_sv: string;
  name_en: string;
  description_sv: string;
  description_en: string;
  price: string;
  tags: string[];
  allergens: string[];
  available: boolean;
  featured: boolean;
  confirmPrice: boolean;
}

export type FieldErrors = Partial<Record<string, string>>;

export interface ParsedItemForm {
  values: ItemFormValues;
  errors: FieldErrors;
  /** Set when the only thing missing is the owner confirming an unusual price. */
  needsPriceConfirm: boolean;
  edit: MenuItemEdit | null;
}

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};
const checked = (form: FormData, name: string) => form.get(name) === "on" || form.get(name) === "true";

const PRICE_MESSAGES: Record<PriceError, Parameters<typeof t>[1]> = {
  empty: "admin.price.empty",
  negative: "admin.price.negative",
  ambiguous: "admin.price.ambiguous",
  "too-many-decimals": "admin.price.decimals",
  "too-large": "admin.price.tooLarge",
  invalid: "admin.price.invalid",
};

function textError(locale: Locale, value: string, max: number): string | undefined {
  const clean = cleanText(value);
  if (!/[^\s\p{Cf}]/u.test(clean)) return t(locale, "admin.form.required");
  if (visibleLength(clean) > max) return t(locale, "admin.form.tooLong").replace("{max}", String(max));
  return undefined;
}

export function parseItemForm(form: FormData, locale: Locale): ParsedItemForm {
  const values: ItemFormValues = {
    name_sv: field(form, "name_sv"),
    name_en: field(form, "name_en"),
    description_sv: field(form, "description_sv"),
    description_en: field(form, "description_en"),
    price: field(form, "price"),
    tags: form.getAll("tags").filter((v): v is string => typeof v === "string" && (MENU_TAGS as readonly string[]).includes(v)),
    allergens: form
      .getAll("allergens")
      .filter((v): v is string => typeof v === "string" && (ALLERGENS as readonly string[]).includes(v))
      .filter((v, i, all) => all.indexOf(v) === i),
    available: checked(form, "available"),
    featured: checked(form, "featured"),
    confirmPrice: checked(form, "confirm_price"),
  };
  const errors: FieldErrors = {};
  for (const [name, max] of [
    ["name_sv", TEXT_LIMITS.name],
    ["name_en", TEXT_LIMITS.name],
    ["description_sv", TEXT_LIMITS.short],
    ["description_en", TEXT_LIMITS.short],
  ] as const) {
    const error = textError(locale, values[name], max);
    if (error) errors[name] = error;
  }

  let needsPriceConfirm = false;
  const price = parseKronor(values.price);
  if (!price.ok) errors.price = t(locale, PRICE_MESSAGES[price.error]);
  else if ((price.ore < PLAUSIBLE_PRICE_ORE.min || price.ore > PLAUSIBLE_PRICE_ORE.max) && !values.confirmPrice) {
    needsPriceConfirm = true;
    errors.price = t(locale, "admin.price.confirm");
  }

  const ok = Object.keys(errors).length === 0 && price.ok;
  return {
    values,
    errors,
    needsPriceConfirm,
    edit: ok
      ? {
          name: { sv: cleanText(values.name_sv), en: cleanText(values.name_en) },
          description: { sv: cleanText(values.description_sv), en: cleanText(values.description_en) },
          priceOre: price.ore,
          tags: values.tags,
          allergens: values.allergens,
          available: values.available,
        }
      : null,
  };
}

export interface ParsedCategoryForm {
  values: { name_sv: string; name_en: string };
  errors: FieldErrors;
  name: { sv: string; en: string } | null;
}

export function parseCategoryForm(form: FormData, locale: Locale): ParsedCategoryForm {
  const values = { name_sv: field(form, "name_sv"), name_en: field(form, "name_en") };
  const errors: FieldErrors = {};
  for (const name of ["name_sv", "name_en"] as const) {
    const error = textError(locale, values[name], TEXT_LIMITS.name);
    if (error) errors[name] = error;
  }
  return { values, errors, name: Object.keys(errors).length ? null : { sv: cleanText(values.name_sv), en: cleanText(values.name_en) } };
}

/** Ore → what the owner would type: 14500 → "145", 14550 → "145,50". */
export function kronorText(ore: number): string {
  const kr = Math.floor(ore / 100);
  const rest = ore % 100;
  return rest === 0 ? String(kr) : `${kr},${String(rest).padStart(2, "0")}`;
}

/** A row_version from a hidden field, or null if it isn't a whole number. */
export function rowVersionOf(form: FormData): number | null {
  const value = field(form, "row_version");
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}
