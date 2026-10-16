/**
 * The content model, as Zod schemas: the single definition of what valid restaurant content
 * is. The JSON demos are validated against it at build time and in CI today; the admin's save
 * path and the D1 seed use the same schemas later (ADR-011 §8), so a rule exists once.
 *
 * Schemas are strict: an unknown key is an error, which catches typos and fields a CMS or
 * script invented. Text is NFC-normalised and stripped of control characters and soft hyphens
 * before it is length-checked; it is not trimmed, so validation never changes visible text.
 */
import { z } from "zod";
import { MAX_PRICE_ORE } from "./price";
import { ALLERGENS, BOOKING_MODES, MENU_TAGS } from "./vocabulary";

export const TEXT_LIMITS = { name: 80, short: 300, long: 3000 } as const;

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

// C0 controls except tab/newline/carriage return, DEL, and the soft hyphen.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­]/g;

export function cleanText(value: string): string {
  return value.normalize("NFC").replace(INVISIBLE, "");
}

const text = (max: number) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .refine((s) => s.trim().length > 0, "must not be empty")
        .refine((s) => s.length <= max, `must be at most ${max} characters`),
    );

/** A bilingual field: both Swedish and English, both non-empty (ADR-004: no fallback). */
export const localized = (max: number) => z.strictObject({ sv: text(max), en: text(max) });

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;

const itemId = z.string().regex(/^[a-z0-9]{12}$/, "must be 12 lowercase letters or digits");
const httpsUrl = z.string().regex(/^https:\/\/[^\s"'<>]+$/, "must be an https:// URL");

/** 24-hour HH:MM. */
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM, 24-hour");

/** A real calendar date, YYYY-MM-DD. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((d) => {
    const parsed = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(d);
  }, "must be a real date");

// close < open is allowed: it means closing after midnight.
export const dayHours = z
  .strictObject({ open: time, close: time })
  .refine((h) => h.open !== h.close, "must not open and close at the same minute");

/** An image path under the site's own folder (Decap uploads there; ADR-008). */
export const imagePath = (site: string) =>
  z.string().refine((p) => new RegExp(`^/images/${site}/[^/]+$`).test(p), `must be under /images/${site}/`);

export const menuItemSchema = (site: string) =>
  z.strictObject({
    id: itemId,
    name: localized(TEXT_LIMITS.name),
    description: localized(TEXT_LIMITS.short),
    price: z.number().int("must be whole öre").min(0, "must not be negative").max(MAX_PRICE_ORE),
    tags: z.array(z.enum(MENU_TAGS)).refine(unique, "must not repeat a tag"),
    allergens: z.array(z.enum(ALLERGENS)).refine(unique, "must not repeat an allergen"),
    available: z.boolean(),
    image: imagePath(site).optional(),
  });

export const menuSchema = (site: string) =>
  z
    .strictObject({
      categories: z.array(
        z.strictObject({
          id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be lowercase words joined by hyphens"),
          name: localized(TEXT_LIMITS.name),
          items: z.array(menuItemSchema(site)),
        }),
      ),
    })
    .refine((m) => unique(m.categories.map((c) => c.id)), "category ids must be unique")
    .refine((m) => unique(m.categories.flatMap((c) => c.items.map((i) => i.id))), "item ids must be unique");

export const hoursSchema = z.strictObject({
  weekly: z.strictObject(
    Object.fromEntries(WEEKDAYS.map((d) => [d, dayHours.nullable()])) as Record<
      (typeof WEEKDAYS)[number],
      z.ZodNullable<typeof dayHours>
    >,
  ),
  exceptions: z
    .array(z.strictObject({ date: isoDate, note: localized(TEXT_LIMITS.short), hours: dayHours.nullable() }))
    .refine((e) => unique(e.map((x) => x.date)), "each date may have only one exception"),
});

export const settingsSchema = z
  .strictObject({
    name: localized(TEXT_LIMITS.name),
    tagline: localized(TEXT_LIMITS.short),
    cuisine: localized(TEXT_LIMITS.name),
    address: text(TEXT_LIMITS.short),
    phone: z.string().regex(/^\+?[\d\s-]{7,}$/, "must be a phone number"),
    email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address"),
    socialLinks: z.record(z.string().regex(/^[a-z]+$/), httpsUrl),
    booking: z.strictObject({
      provider: z.enum(BOOKING_MODES),
      embedCode: z.string().optional(),
      bookingUrl: z.string().optional(),
    }),
    mapEmbed: z.union([z.literal(""), httpsUrl]),
  })
  .superRefine((s, ctx) => {
    if (s.booking.provider === "link" && !httpsUrl.safeParse(s.booking.bookingUrl).success) {
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
        tagline: localized(TEXT_LIMITS.short),
        highlights: z.array(itemId).refine(unique, "must not repeat a highlight"),
        heroImage: imagePath(site).optional(),
        highlightImages: z.record(itemId, imagePath(site)).optional(),
        pullQuote: localized(TEXT_LIMITS.short).optional(),
        ctaImage: imagePath(site).optional(),
      })
      .refine(
        (h) => Object.keys(h.highlightImages ?? {}).every((id) => h.highlights.includes(id)),
        "highlightImages may only name highlighted items",
      ),
    menu: z.strictObject({ heroImage: imagePath(site).optional() }),
    about: z.strictObject({
      story: localized(TEXT_LIMITS.long),
      chef: localized(TEXT_LIMITS.long),
      storyImage: imagePath(site).optional(),
      kitchenImage: imagePath(site).optional(),
    }),
  });

export const gallerySchema = (site: string) =>
  z.strictObject({
    images: z.array(z.strictObject({ src: imagePath(site), alt: localized(TEXT_LIMITS.short) })),
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
      const items = new Map(c.menu.categories.flatMap((cat) => cat.items.map((i) => [i.id, i] as const)));
      c.pages.home.highlights.forEach((id, index) => {
        const item = items.get(id);
        if (!item || !item.available) {
          ctx.addIssue({
            code: "custom",
            path: ["pages", "home", "highlights", index],
            message: item ? "highlights an unavailable item" : "highlights an item that does not exist",
          });
        }
      });
    });

export type LocalizedString = z.output<ReturnType<typeof localized>>;
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
