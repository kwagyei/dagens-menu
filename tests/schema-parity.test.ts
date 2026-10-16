/**
 * Parity: every rule the content tests enforced before the schema existed, plus the rules
 * added for the save path, each with at least one bad value the schema must reject. Each case
 * breaks one thing in a copy of the real bistro content and expects an issue at the given
 * path whose message contains the given text, so the case proves which rule fired.
 */
import { describe, expect, it } from "vitest";
import { siteContentSchema } from "../src/content/schema";
import { readSiteJson } from "./site-fixtures";

type Content = ReturnType<typeof readSiteJson>;
const SITE = "bistro";
const base = readSiteJson(SITE);

function issuesAfter(mutate: (c: Content) => void): Array<{ path: string; message: string }> {
  const copy = structuredClone(base);
  mutate(copy);
  const result = siteContentSchema(SITE).safeParse(copy);
  return result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

const firstItem = (c: Content) => c.menu.categories[0].items[0];
const item = "menu.categories.0.items.0";

it("accepts the unmodified content", () => {
  expect(issuesAfter(() => {})).toEqual([]);
});

const cases: Array<[rule: string, mutate: (c: Content) => void, path: string, message: string]> = [
  // Both languages present and non-empty
  ["English missing", (c) => delete firstItem(c).name.en, `${item}.name.en`, "expected string"],
  ["English blank", (c) => (firstItem(c).name.en = "   "), `${item}.name.en`, "must not be empty"],
  ["a third language", (c) => (firstItem(c).name.de = "Suppe"), `${item}.name`, "Unrecognized key"],
  ["invisible characters only", (c) => (c.settings.tagline.sv = "\u0007­​‮"), "settings.tagline.sv", "must not be empty"],
  // Length caps
  ["dish name over 80", (c) => (firstItem(c).name.sv = "x".repeat(81)), `${item}.name.sv`, "at most 80"],
  ["description over 300", (c) => (firstItem(c).description.en = "x".repeat(301)), `${item}.description.en`, "at most 300"],
  ["story over 3000", (c) => (c.pages.about.story.sv = "x".repeat(3001)), "pages.about.story.sv", "at most 3000"],
  // Images: a file directly under the site's own folder
  ["another site's image", (c) => (c.gallery.images[0].src = "/images/westafrican/x.jpg"), "gallery.images.0.src", "under /images/bistro/"],
  ["image path traversal", (c) => (c.pages.home.heroImage = "/images/bistro/../secret.jpg"), "pages.home.heroImage", "under /images/bistro/"],
  ["image path that is a directory", (c) => (c.pages.home.heroImage = "/images/bistro/.."), "pages.home.heroImage", "under /images/bistro/"],
  // Unique, URL-safe category ids
  ["category id with a space", (c) => (c.menu.categories[0].id = "lunch menu"), "menu.categories.0.id", "lowercase words"],
  ["duplicate category id", (c) => (c.menu.categories[1].id = c.menu.categories[0].id), "menu.categories.1.id", "duplicate category id"],
  // Prices: non-negative whole öre
  ["fractional öre", (c) => (firstItem(c).price = 145.5), `${item}.price`, "whole öre"],
  ["negative price", (c) => (firstItem(c).price = -100), `${item}.price`, "must not be negative"],
  ["price as a string", (c) => (firstItem(c).price = "145"), `${item}.price`, "expected number"],
  // Tags and EU-14 allergens from the vocabulary, no duplicates
  ["unknown tag", (c) => (firstItem(c).tags = ["halal"]), `${item}.tags.0`, "Invalid option"],
  ["duplicate tag", (c) => (firstItem(c).tags = ["vegan", "vegan"]), `${item}.tags`, "repeat a tag"],
  ["unknown allergen", (c) => (firstItem(c).allergens = ["shellfish"]), `${item}.allergens.0`, "Invalid option"],
  ["duplicate allergen", (c) => (firstItem(c).allergens = ["milk", "milk"]), `${item}.allergens`, "repeat an allergen"],
  // Availability is a boolean
  ["available as a string", (c) => (firstItem(c).available = "yes"), `${item}.available`, "expected boolean"],
  // Stable item ids
  ["malformed item id", (c) => (firstItem(c).id = "Soup-1"), `${item}.id`, "12 lowercase"],
  ["duplicate item id", (c) => (c.menu.categories[1].items[0].id = firstItem(c).id), "menu.categories.1.items.0.id", "duplicate item id"],
  // Highlights exist (an unavailable one is fine: the page skips it)
  ["highlight of a missing item", (c) => (c.pages.home.highlights[0] = "zzzzzzzzzzzz"), "pages.home.highlights.0", "does not exist"],
  ["repeated highlight", (c) => c.pages.home.highlights.push(c.pages.home.highlights[0]), "pages.home.highlights", "repeat a highlight"],
  [
    "highlight image for an item that isn't highlighted",
    (c) => (c.pages.home.highlightImages = { ...c.pages.home.highlightImages, zzzzzzzzzzzz: "/images/bistro/x.jpg" }),
    "pages.home.highlightImages.zzzzzzzzzzzz",
    "not highlighted",
  ],
  ["highlight image with a malformed id", (c) => (c.pages.home.highlightImages = { "lunch-0": "/images/bistro/x.jpg" }), "pages.home.highlightImages.lunch-0", "Invalid key"],
  // Seven weekdays, nothing else
  ["a weekday missing", (c) => delete c.hours.weekly.sunday, "hours.weekly.sunday", "expected object"],
  ["an extra weekday", (c) => (c.hours.weekly.funday = null), "hours.weekly", "Unrecognized key"],
  // HH:MM, 24-hour, never open and close at the same minute
  ["close at 25:00", (c) => (c.hours.weekly.monday = { open: "11:00", close: "25:00" }), "hours.weekly.monday.close", "HH:MM"],
  ["12-hour time", (c) => (c.hours.weekly.monday = { open: "11am", close: "22:00" }), "hours.weekly.monday.open", "HH:MM"],
  ["open equals close", (c) => (c.hours.weekly.monday = { open: "11:00", close: "11:00" }), "hours.weekly.monday", "same minute"],
  // Exceptions: real dates in range, at most once, hours checked too
  [
    "impossible date",
    (c) => (c.hours.exceptions = [{ date: "2026-02-30", note: { sv: "Stängt", en: "Closed" }, hours: null }]),
    "hours.exceptions.0.date",
    "real date",
  ],
  [
    "date far in the future",
    (c) => (c.hours.exceptions = [{ date: "9999-12-31", note: { sv: "Stängt", en: "Closed" }, hours: null }]),
    "hours.exceptions.0.date",
    "between 2000 and 2099",
  ],
  [
    "duplicate exception date",
    (c) => {
      const e = { date: "2026-12-24", note: { sv: "Julafton", en: "Christmas Eve" }, hours: null };
      c.hours.exceptions = [e, { ...e }];
    },
    "hours.exceptions.1.date",
    "duplicate exception date",
  ],
  [
    "exception with blank hours",
    (c) =>
      (c.hours.exceptions = [{ date: "2026-12-31", note: { sv: "Nyår", en: "New Year" }, hours: { open: "", close: "" } }]),
    "hours.exceptions.0.hours.open",
    "HH:MM",
  ],
  // Booking settings: consistent with their mode, and checked whenever present
  ["unknown booking mode", (c) => (c.settings.booking.provider = "phone"), "settings.booking.provider", "Invalid option"],
  ["link mode without a URL", (c) => (c.settings.booking = { provider: "link" }), "settings.booking.bookingUrl", "link mode needs"],
  ["embed mode without code", (c) => (c.settings.booking = { provider: "embed", embedCode: " " }), "settings.booking.embedCode", "embed mode needs"],
  ["non-https booking URL in another mode", (c) => (c.settings.booking = { provider: "none", bookingUrl: "javascript:alert(1)" }), "settings.booking.bookingUrl", "https://"],
  ["oversized embed code", (c) => (c.settings.booking = { provider: "embed", embedCode: "x".repeat(5001) }), "settings.booking.embedCode", "5000"],
  // Contact formats
  ["email without a domain", (c) => (c.settings.email = "hej@"), "settings.email", "email address"],
  ["phone with letters", (c) => (c.settings.phone = "ring oss"), "settings.phone", "phone number"],
  ["phone with too few digits", (c) => (c.settings.phone = "-------"), "settings.phone", "7 digits"],
  ["phone over 40 characters", (c) => (c.settings.phone = "1".repeat(41)), "settings.phone", "at most 40"],
  ["email with a bidi override", (c) => (c.settings.email = "a\u202e@b.se"), "settings.email", "email address"],
  ["email over 254 characters", (c) => (c.settings.email = `${"a".repeat(250)}@b.se`), "settings.email", "at most 254"],
  ["social link with a zero-width space", (c) => (c.settings.socialLinks = { instagram: "https://insta\u200bgram.com/x" }), "settings.socialLinks.instagram", "https:// URL"],
  ["social link over 2000 characters", (c) => (c.settings.socialLinks = { instagram: `https://x.se/${"a".repeat(2000)}` }), "settings.socialLinks.instagram", "at most 2000"],
  ["http social link", (c) => (c.settings.socialLinks.instagram = "http://instagram.com/x"), "settings.socialLinks.instagram", "https://"],
  ["social link with no host", (c) => (c.settings.socialLinks.instagram = "https://"), "settings.socialLinks.instagram", "https://"],
  ["bad social network name", (c) => (c.settings.socialLinks = { "Insta Gram": "https://x.se" }), "settings.socialLinks.Insta Gram", "Invalid key"],
  ["__proto__ social link", (c) => (c.settings.socialLinks = JSON.parse('{"__proto__": "https://x.se"}')), "settings.socialLinks", "__proto__"],
  ["map that is not https", (c) => (c.settings.mapEmbed = "javascript:alert(1)"), "settings.mapEmbed", "https://"],
  // Theme: hex colours, the keys the templates use, CSS-safe values
  ["three-digit colour", (c) => (c.theme.colors.primary = "#abc"), "theme.colors.primary", "six-digit hex"],
  ["theme colour missing", (c) => delete c.theme.colors.heroBg, "theme.colors.heroBg", "expected string"],
  ["font stack with CSS injection", (c) => (c.theme.fonts.body = "x; } body { display:none"), "theme.fonts.body", "font stack"],
  ["corner radius that isn't a length", (c) => (c.theme.cornerRadius = "1rem; color: red"), "theme.cornerRadius", "CSS length"],
  ["unknown hero style", (c) => (c.theme.heroStyle = "carousel"), "theme.heroStyle", "Invalid option"],
  // Unknown keys are errors
  ["unknown field on a dish", (c) => (firstItem(c).spicy = true), item, "Unrecognized key"],
];

describe("the schema rejects", () => {
  it.each(cases)("%s", (_rule, mutate, path, message) => {
    const issues = issuesAfter(mutate);
    expect(issues.some((i) => i.path === path && i.message.includes(message)), JSON.stringify(issues)).toBe(true);
  });
});
