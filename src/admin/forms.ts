/**
 * Turning posted admin forms into edits (ADR-011 §8, plan M5.2). Pure: no database, no
 * Astro, so every rule is unit-tested. A form either yields a clean edit or field-by-field
 * errors in the owner's language, and always keeps exactly what was typed, so a rejected
 * form comes back filled in.
 *
 * The repository validates again with the content schema; these checks are the friendly
 * first line, worded for owners rather than developers.
 */
import { cleanText, ownerSettingsSchema, socialLinkUrl, TEXT_LIMITS, visibleLength } from "../content/schema";
import { parseKronor, type PriceError } from "../content/price";
import { ALLERGENS, MENU_TAGS, SOCIAL_NETWORKS, WEEKDAYS, type Weekday } from "../content/vocabulary";
import type { MenuItemEdit } from "../db/repository";
import type { OwnerSettings, PageTexts } from "../db/texts";
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

/**
 * The browser's maxlength counts UTF-16 units, not characters: one emoji is two, so a
 * maxlength equal to the limit would stop a valid name short. Twice the limit still stops
 * a pasted novel; the server checks the real limit and says so in the owner's words.
 */
export const inputMaxLength = (limit: number) => limit * 2;

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

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
type Hours = { open: string; close: string };

/** One day's opening and closing time, or closed; an error message if neither is valid. */
function dayHoursFrom(form: FormData, prefix: string, closedField: string, locale: Locale): { hours: Hours | null; error?: string; open: string; close: string; closed: boolean } {
  const closed = checked(form, closedField);
  const open = field(form, `${prefix}_open`).trim();
  const close = field(form, `${prefix}_close`).trim();
  if (closed) return { hours: null, open, close, closed };
  if (!open || !close) return { hours: null, open, close, closed, error: t(locale, "admin.hours.timesRequired") };
  if (!TIME.test(open) || !TIME.test(close)) return { hours: null, open, close, closed, error: t(locale, "admin.hours.badTime") };
  if (open === close) return { hours: null, open, close, closed, error: t(locale, "admin.hours.sameTime") };
  return { hours: { open, close }, open, close, closed };
}

export interface WeeklyFormValues {
  days: Record<Weekday, { open: string; close: string; closed: boolean }>;
}

export function parseHoursForm(form: FormData, locale: Locale) {
  const days = {} as WeeklyFormValues["days"];
  const weekly = {} as Record<Weekday, Hours | null>;
  const errors: FieldErrors = {};
  for (const day of WEEKDAYS) {
    const parsed = dayHoursFrom(form, day, `${day}_closed`, locale);
    days[day] = { open: parsed.open, close: parsed.close, closed: parsed.closed };
    weekly[day] = parsed.hours;
    if (parsed.error) errors[day] = parsed.error;
  }
  return { values: { days }, errors, weekly: Object.keys(errors).length ? null : weekly };
}

export interface ExceptionFormValues {
  date: string;
  closed: boolean;
  open: string;
  close: string;
  note_sv: string;
  note_en: string;
}

export function parseExceptionForm(form: FormData, locale: Locale) {
  const parsed = dayHoursFrom(form, "exception", "closed", locale);
  const values: ExceptionFormValues = {
    date: field(form, "date").trim(),
    closed: parsed.closed,
    open: parsed.open,
    close: parsed.close,
    note_sv: field(form, "note_sv"),
    note_en: field(form, "note_en"),
  };
  const errors: FieldErrors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) errors.date = t(locale, "admin.hours.badDate");
  if (parsed.error) errors.hours = parsed.error;
  for (const name of ["note_sv", "note_en"] as const) {
    const error = textError(locale, values[name], TEXT_LIMITS.short);
    if (error) errors[name] = error;
  }
  const ok = Object.keys(errors).length === 0;
  return {
    values,
    errors,
    exception: ok ? { date: values.date, hours: parsed.hours, note: { sv: cleanText(values.note_sv), en: cleanText(values.note_en) } } : null,
  };
}

const SETTINGS_TEXT_FIELDS = [
  ["name_sv", TEXT_LIMITS.name],
  ["name_en", TEXT_LIMITS.name],
  ["tagline_sv", TEXT_LIMITS.short],
  ["tagline_en", TEXT_LIMITS.short],
  ["cuisine_sv", TEXT_LIMITS.name],
  ["cuisine_en", TEXT_LIMITS.name],
  ["address", TEXT_LIMITS.short],
] as const;

export type SettingsFormValues = Record<(typeof SETTINGS_TEXT_FIELDS)[number][0] | "phone" | "email", string> & {
  social: Record<(typeof SOCIAL_NETWORKS)[number], string>;
};

export interface ParsedSettingsForm {
  values: SettingsFormValues;
  errors: FieldErrors;
  settings: OwnerSettings | null;
}

/**
 * The settings form. Social links have one field per network the admin offers; an empty
 * field removes that link. `storedLinks` are the links saved now: networks among them that
 * the form doesn't offer (set by the operator) are kept as they are.
 */
export function parseSettingsForm(form: FormData, locale: Locale, storedLinks: Record<string, string> = {}): ParsedSettingsForm {
  const values = {
    ...Object.fromEntries(SETTINGS_TEXT_FIELDS.map(([name]) => [name, field(form, name)])),
    phone: field(form, "phone"),
    email: field(form, "email"),
    social: Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, field(form, `social_${n}`).trim()])),
  } as SettingsFormValues;
  const errors: FieldErrors = {};
  for (const [name, max] of SETTINGS_TEXT_FIELDS) {
    const error = textError(locale, values[name], max);
    if (error) errors[name] = error;
  }
  const phone = ownerSettingsSchema.shape.phone.safeParse(values.phone);
  const email = ownerSettingsSchema.shape.email.safeParse(values.email.trim());
  if (!phone.success) errors.phone = t(locale, "admin.texts.badPhone");
  if (!email.success) errors.email = t(locale, "admin.texts.badEmail");
  for (const network of SOCIAL_NETWORKS) {
    const url = values.social[network];
    if (url && !socialLinkUrl.safeParse(url).success) errors[`social_${network}`] = t(locale, "admin.texts.badLink");
  }
  if (Object.keys(errors).length > 0 || !phone.success || !email.success) return { values, errors, settings: null };

  const offered = new Set<string>(SOCIAL_NETWORKS);
  const kept = Object.entries(storedLinks).filter(([network]) => !offered.has(network));
  const entered = SOCIAL_NETWORKS.filter((n) => values.social[n]).map((n) => [n, values.social[n]]);
  const pair = (base: "name" | "tagline" | "cuisine") => ({ sv: cleanText(values[`${base}_sv`]), en: cleanText(values[`${base}_en`]) });
  return {
    values,
    errors,
    settings: {
      name: pair("name"),
      tagline: pair("tagline"),
      cuisine: pair("cuisine"),
      address: cleanText(values.address),
      phone: phone.data,
      email: email.data,
      socialLinks: Object.fromEntries([...kept, ...entered]),
    },
  };
}

const PAGE_TEXTS = { home_tagline: TEXT_LIMITS.short, pull_quote: TEXT_LIMITS.short, about_story: TEXT_LIMITS.long, about_chef: TEXT_LIMITS.long } as const;
type PageTextField = keyof typeof PAGE_TEXTS;

export type PageTextsFormValues = Record<`${PageTextField}_${Locale}`, string>;

export interface ParsedPageTextsForm {
  values: PageTextsFormValues;
  errors: FieldErrors;
  texts: PageTexts | null;
}

const isBlank = (value: string) => !/[^\s\p{Cf}]/u.test(cleanText(value));

/** The page texts form. The pull quote is optional, but in both languages or neither. */
export function parsePageTextsForm(form: FormData, locale: Locale): ParsedPageTextsForm {
  const fields = Object.keys(PAGE_TEXTS) as PageTextField[];
  const values = Object.fromEntries(fields.flatMap((f) => [`${f}_sv`, `${f}_en`]).map((n) => [n, field(form, n)])) as PageTextsFormValues;
  const hasQuote = !isBlank(values.pull_quote_sv) || !isBlank(values.pull_quote_en);
  const errors: FieldErrors = {};
  for (const f of fields) {
    if (f === "pull_quote" && !hasQuote) continue;
    for (const lang of ["sv", "en"] as const) {
      const name = `${f}_${lang}` as const;
      const missing = f === "pull_quote" && isBlank(values[name]);
      const error = missing ? t(locale, "admin.texts.quoteBoth") : textError(locale, values[name], PAGE_TEXTS[f]);
      if (error) errors[name] = error;
    }
  }
  if (Object.keys(errors).length > 0) return { values, errors, texts: null };
  const pair = (f: PageTextField) => ({ sv: cleanText(values[`${f}_sv`]), en: cleanText(values[`${f}_en`]) });
  return {
    values,
    errors,
    texts: { homeTagline: pair("home_tagline"), pullQuote: hasQuote ? pair("pull_quote") : null, aboutStory: pair("about_story"), aboutChef: pair("about_chef") },
  };
}
