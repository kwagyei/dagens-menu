/**
 * The content model, as Zod schemas: the single definition of what valid restaurant content
 * is. The JSON demos are validated against it at build time and in CI today; the admin's save
 * path and the D1 seed use the same schemas later (ADR-011 §8), so a rule exists once.
 *
 * Schemas are strict: an unknown key is an error, which catches typos and fields a CMS or
 * script invented. Text is NFC-normalised and stripped of invisible characters before it is
 * checked; it is not trimmed, so validation never changes visible text.
 *
 * Zod skips an object's own refinements while that object has other errors, so cross-field
 * rules (unique ids, highlights) report on a later pass once field errors are fixed.
 */
import { z } from "zod";
import { MAX_PRICE_ORE } from "./price";
import { ALLERGENS, BOOKING_MODES, MENU_TAGS, WEEKDAYS } from "./vocabulary";

export { WEEKDAYS };

export const TEXT_LIMITS = { name: 80, short: 300, long: 3000, embed: 5000 } as const;

/** Exception dates must fall in this range; the admin narrows it to two years ahead (ADR-011 §8). */
export const DATE_RANGE = { minYear: 2000, maxYear: 2099 } as const;

// Control characters except tab, newline and carriage return; the soft hyphen; zero-width
// space, word joiner and byte-order mark; bidi embeddings, overrides and isolates, which can
// make a saved name or price display reversed. ZWJ and ZWNJ stay: emoji and some scripts need them.
const INVISIBLE = /(?![\t\n\r])\p{Cc}|[­​⁠﻿‪-‮⁦-⁩]/gu;

export function cleanText(value: string): string {
  return value.normalize("NFC").replace(INVISIBLE, "");
}

const graphemes = new Intl.Segmenter("sv", { granularity: "grapheme" });

/** Length as a reader counts it: one emoji or one å is one character. */
export function visibleLength(value: string): number {
  let count = 0;
  for (const _ of graphemes.segment(value)) count++;
  return count;
}

const text = (max: number) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .refine((s) => /[^\s\p{Cf}]/u.test(s), "must not be empty")
        .refine((s) => visibleLength(s) <= max, `must be at most ${max} characters`),
    );

/** A bilingual text field: both Swedish and English, both non-empty (ADR-004: no fallback). */
export const localizedText = (max: number) => z.strictObject({ sv: text(max), en: text(max) });

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;

const itemId = z.string().regex(/^[a-z0-9]{12}$/, "must be 12 lowercase letters or digits");
const httpsUrl = z.string().regex(/^https:\/\/[^\s"'<>/]+(\/[^\s"'<>]*)?$/, "must be an https:// URL");

/**
 * A string-keyed record. JSON.parse makes "__proto__" an own key, which z.record drops
 * silently, unchecked; reject it instead.
 */
const record = <K extends z.ZodType<string>, V extends z.ZodType>(key: K, value: V) =>
  z
    .custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null && !Array.isArray(v), "must be an object")
    .refine((v) => !Object.hasOwn(v, "__proto__"), "must not use the key __proto__")
    .pipe(z.record(key, value));

/** 24-hour HH:MM. */
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, 24-hour");

/** A real calendar date, YYYY-MM-DD, within DATE_RANGE. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((d) => {
    const parsed = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(d);
  }, "must be a real date")
  .refine((d) => {
    const year = Number(d.slice(0, 4));
    return year >= DATE_RANGE.minYear && year <= DATE_RANGE.maxYear;
  }, `must be between ${DATE_RANGE.minYear} and ${DATE_RANGE.maxYear}`);

// close < open is allowed: it means closing after midnight.
export const dayHours = z
  .strictObject({ open: time, close: time })
  .refine((h) => h.open !== h.close, "must not open and close at the same minute");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An image file directly under the site's own folder (where uploads go; ADR-008). */
export const imagePath = (site: string) => {
  const pattern = new RegExp(`^/images/${escapeRegExp(site)}/[A-Za-z0-9_-][A-Za-z0-9._-]*$`);
  return z.string().regex(pattern, `must be a file under /images/${site}/`);
};

export const menuItemSchema = (site: string) =>
  z.strictObject({
    id: itemId,
    name: localizedText(TEXT_LIMITS.name),
    description: localizedText(TEXT_LIMITS.short),
    price: z.number().int("must be whole öre").min(0, "must not be negative").max(MAX_PRICE_ORE),
    tags: z.array(z.enum(MENU_TAGS)).refine(unique, "must not repeat a tag"),
    allergens: z.array(z.enum(ALLERGENS)).refine(unique, "must not repeat an allergen"),
    available: z.boolean(),
    image: imagePath(site).optional(),
  });

/** Adds an issue at each later occurrence of a repeated value. */
function reportDuplicates(ctx: z.RefinementCtx, values: string[], pathOf: (index: number) => PropertyKey[], what: string) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) ctx.addIssue({ code: "custom", path: pathOf(index), message: `duplicate ${what} "${value}"` });
    seen.add(value);
  });
}

export const menuSchema = (site: string) =>
  z
    .strictObject({
      categories: z.array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be lowercase words joined by hyphens"),
          name: localizedText(TEXT_LIMITS.name),
          items: z.array(menuItemSchema(site)),
        }),
      ),
    })
    .superRefine((menu, ctx) => {
      reportDuplicates(ctx, menu.categories.map((c) => c.id), (i) => ["categories", i, "id"], "category id");
      const positions = menu.categories.flatMap((c, ci) => c.items.map((item, ii) => ({ id: item.id, ci, ii })));
      reportDuplicates(ctx, positions.map((p) => p.id), (i) => ["categories", positions[i].ci, "items", positions[i].ii, "id"], "item id");
    });

export const hoursSchema = z.strictObject({
  weekly: z.strictObject(
    Object.fromEntries(WEEKDAYS.map((d) => [d, dayHours.nullable()])) as Record<
      (typeof WEEKDAYS)[number],
      z.ZodNullable<typeof dayHours>
    >,
  ),
  exceptions: z
    .array(z.strictObject({ date: isoDate, note: localizedText(TEXT_LIMITS.short), hours: dayHours.nullable() }))
    .superRefine((list, ctx) => reportDuplicates(ctx, list.map((e) => e.date), (i) => [i, "date"], "exception date")),
});

const settingsFields = z.strictObject({
  name: localizedText(TEXT_LIMITS.name),
  tagline: localizedText(TEXT_LIMITS.short),
  cuisine: localizedText(TEXT_LIMITS.name),
  address: text(TEXT_LIMITS.short),
  phone: z
    .string()
    .regex(/^\+?[\d\s-]+$/, "must be a phone number")
    .refine((p) => (p.match(/\d/g) ?? []).length >= 7, "must have at least 7 digits"),
  email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address"),
  socialLinks: record(z.string().regex(/^[a-z]+$/, "must be a lowercase network name"), httpsUrl),
  // Booking and map fields are operator-only (ADR-011 §8); checked whenever present, so a
  // value can't sit unchecked until someone switches the mode.
  booking: z.strictObject({
    provider: z.enum(BOOKING_MODES),
    embedCode: z.string().max(TEXT_LIMITS.embed).optional(),
    bookingUrl: httpsUrl.optional(),
  }),
  mapEmbed: z.union([z.literal(""), httpsUrl]),
});

/** The settings an owner may edit in the admin: everything but booking and the map (ADR-011 §8). */
export const ownerSettingsSchema = settingsFields.pick({ name: true, tagline: true, cuisine: true, address: true, phone: true, email: true, socialLinks: true });

/** One social link as the admin checks it. */
export const socialLinkUrl = httpsUrl;

export const settingsSchema = settingsFields.superRefine((s, ctx) => {
  if (s.booking.provider === "link" && !s.booking.bookingUrl) {
    ctx.addIssue({ code: "custom", path: ["booking", "bookingUrl"], message: "link mode needs an https:// booking URL" });
  }
  if (s.booking.provider === "embed" && !s.booking.embedCode?.trim()) {
    ctx.addIssue({ code: "custom", path: ["booking", "embedCode"], message: "embed mode needs embed code" });
  }
});

export const pagesSchema = (site: string) =>
  z.strictObject({
    home: z
      .strictObject({
        tagline: localizedText(TEXT_LIMITS.short),
        highlights: z.array(itemId).refine(unique, "must not repeat a highlight"),
        heroImage: imagePath(site).optional(),
        highlightImages: record(itemId, imagePath(site)).optional(),
        pullQuote: localizedText(TEXT_LIMITS.short).optional(),
        ctaImage: imagePath(site).optional(),
      })
      .superRefine((home, ctx) => {
        for (const id of Object.keys(home.highlightImages ?? {})) {
          if (!home.highlights.includes(id)) {
            ctx.addIssue({ code: "custom", path: ["highlightImages", id], message: "names an item that is not highlighted" });
          }
        }
      }),
    menu: z.strictObject({ heroImage: imagePath(site).optional() }),
    about: z.strictObject({
      story: localizedText(TEXT_LIMITS.long),
      chef: localizedText(TEXT_LIMITS.long),
      storyImage: imagePath(site).optional(),
      kitchenImage: imagePath(site).optional(),
    }),
  });

/** The page texts an owner edits in the admin; same rules as the matching fields of pagesSchema. */
export const pageTextsSchema = z.strictObject({
  homeTagline: localizedText(TEXT_LIMITS.short),
  pullQuote: localizedText(TEXT_LIMITS.short).nullable(),
  aboutStory: localizedText(TEXT_LIMITS.long),
  aboutChef: localizedText(TEXT_LIMITS.long),
});

export const gallerySchema = (site: string) =>
  z.strictObject({
    images: z.array(z.strictObject({ src: imagePath(site), alt: localizedText(TEXT_LIMITS.short) })),
  });

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "must be a six-digit hex colour");
// Fonts and radius are interpolated into CSS: allow only what a font stack or length needs.
const fontStack = z.string().regex(/^[\w\s,'"-]+$/, "must be a plain font stack");

export const themeSchema = z.strictObject({
  colors: z.strictObject({
    primary: hex,
    secondary: hex,
    accent: hex,
    background: hex,
    surface: hex,
    surfaceAlt: hex,
    text: hex,
    textMuted: hex,
    border: hex,
    heroBg: hex,
    heroText: hex,
    heroMuted: hex,
  }),
  fonts: z.strictObject({ heading: fontStack, display: fontStack, body: fontStack }),
  cornerRadius: z.string().regex(/^\d+(\.\d+)?(rem|px|em)$|^0$/, "must be a CSS length"),
  heroStyle: z.enum(["image-overlay", "side-by-side", "text-only"]),
});

/** A whole site's content, with the rules that span files. */
export const siteContentSchema = (site: string) =>
  z
    .strictObject({
      settings: settingsSchema,
      hours: hoursSchema,
      menu: menuSchema(site),
      pages: pagesSchema(site),
      gallery: gallerySchema(site),
      theme: themeSchema,
    })
    .superRefine((c, ctx) => {
      // Highlights must exist. A highlighted dish that is unavailable (sold out) is valid:
      // the home page skips it, and marking a dish sold out must never break the site.
      const ids = new Set(c.menu.categories.flatMap((cat) => cat.items.map((i) => i.id)));
      c.pages.home.highlights.forEach((id, index) => {
        if (!ids.has(id)) {
          ctx.addIssue({ code: "custom", path: ["pages", "home", "highlights", index], message: "highlights an item that does not exist" });
        }
      });
    });

export type LocalizedString = z.output<ReturnType<typeof localizedText>>;
export type DayHours = z.output<typeof dayHours>;
export type OpeningHours = z.output<typeof hoursSchema>;
export type MenuItem = z.output<ReturnType<typeof menuItemSchema>>;
export type Menu = z.output<ReturnType<typeof menuSchema>>;
export type MenuCategory = Menu["categories"][number];
export type SiteSettings = z.output<typeof settingsSchema>;
export type Pages = z.output<ReturnType<typeof pagesSchema>>;
export type GalleryImage = z.output<ReturnType<typeof gallerySchema>>["images"][number];
export type Gallery = z.output<ReturnType<typeof gallerySchema>>;
export type Theme = z.output<typeof themeSchema>;
export type SiteContent = z.output<ReturnType<typeof siteContentSchema>>;
