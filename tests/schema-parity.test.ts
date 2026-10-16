/**
 * Parity: every rule the content tests enforced before the schema existed, each with at least
 * one bad value the schema must reject. Each case breaks one thing in a copy of the real
 * bistro content and expects an issue at the given path.
 */
import { describe, expect, it } from "vitest";
import { siteContentSchema } from "../src/content/schema";
import { readSiteJson } from "./site-fixtures";

type Content = ReturnType<typeof readSiteJson>;
const SITE = "bistro";
const base = readSiteJson(SITE);

function issuesAfter(mutate: (c: Content) => void): string[] {
  const copy = structuredClone(base);
  mutate(copy);
  const result = siteContentSchema(SITE).safeParse(copy);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
}

const firstItem = (c: Content) => c.menu.categories[0].items[0];

it("accepts the unmodified content", () => {
  expect(issuesAfter(() => {})).toEqual([]);
});

const cases: Array<[rule: string, mutate: (c: Content) => void, path: string]> = [
  // Both languages present and non-empty
  ["English missing", (c) => delete firstItem(c).name.en, "menu.categories.0.items.0.name.en"],
  ["English blank", (c) => (firstItem(c).name.en = "   "), "menu.categories.0.items.0.name.en"],
  ["a third language", (c) => (firstItem(c).name.de = "Suppe"), "menu.categories.0.items.0.name"],
  ["control characters only", (c) => (c.settings.tagline.sv = "\u0007­"), "settings.tagline.sv"],
  // Length caps (new on the save path)
  ["dish name over 80", (c) => (firstItem(c).name.sv = "x".repeat(81)), "menu.categories.0.items.0.name.sv"],
  ["description over 300", (c) => (firstItem(c).description.en = "x".repeat(301)), "menu.categories.0.items.0.description.en"],
  ["story over 3000", (c) => (c.pages.about.story.sv = "x".repeat(3001)), "pages.about.story.sv"],
  // Images under the site's own folder
  ["another site's image", (c) => (c.gallery.images[0].src = "/images/westafrican/x.jpg"), "gallery.images.0.src"],
  ["image path traversal", (c) => (c.pages.home.heroImage = "/images/bistro/../secret.jpg"), "pages.home.heroImage"],
  // Unique, URL-safe category ids
  ["category id with a space", (c) => (c.menu.categories[0].id = "lunch menu"), "menu.categories.0.id"],
  ["duplicate category id", (c) => (c.menu.categories[1].id = c.menu.categories[0].id), "menu"],
  // Prices: non-negative whole öre
  ["fractional öre", (c) => (firstItem(c).price = 145.5), "menu.categories.0.items.0.price"],
  ["negative price", (c) => (firstItem(c).price = -100), "menu.categories.0.items.0.price"],
  ["price as a string", (c) => (firstItem(c).price = "145"), "menu.categories.0.items.0.price"],
  // Tags and EU-14 allergens from the vocabulary, no duplicates
  ["unknown tag", (c) => (firstItem(c).tags = ["halal"]), "menu.categories.0.items.0.tags.0"],
  ["unknown allergen", (c) => (firstItem(c).allergens = ["shellfish"]), "menu.categories.0.items.0.allergens.0"],
  ["duplicate allergen", (c) => (firstItem(c).allergens = ["milk", "milk"]), "menu.categories.0.items.0.allergens"],
  // Availability is a boolean
  ["available as a string", (c) => (firstItem(c).available = "yes"), "menu.categories.0.items.0.available"],
  // Stable item ids
  ["malformed item id", (c) => (firstItem(c).id = "Soup-1"), "menu.categories.0.items.0.id"],
  ["duplicate item id", (c) => (c.menu.categories[1].items[0].id = firstItem(c).id), "menu"],
  // Highlights resolve to existing, available items
  ["highlight of a missing item", (c) => (c.pages.home.highlights[0] = "zzzzzzzzzzzz"), "pages.home.highlights.0"],
  [
    "highlight of an unavailable item",
    (c) => {
      const id = c.pages.home.highlights[0];
      for (const cat of c.menu.categories) for (const i of cat.items) if (i.id === id) i.available = false;
    },
    "pages.home.highlights.0",
  ],
  ["repeated highlight", (c) => c.pages.home.highlights.push(c.pages.home.highlights[0]), "pages.home.highlights"],
  // Seven weekdays, nothing else
  ["a weekday missing", (c) => delete c.hours.weekly.sunday, "hours.weekly.sunday"],
  ["an extra weekday", (c) => (c.hours.weekly.funday = null), "hours.weekly"],
  // HH:MM, 24-hour, never open and close at the same minute
  ["close at 25:00", (c) => (c.hours.weekly.monday = { open: "11:00", close: "25:00" }), "hours.weekly.monday.close"],
  ["12-hour time", (c) => (c.hours.weekly.monday = { open: "11am", close: "22:00" }), "hours.weekly.monday.open"],
  ["open equals close", (c) => (c.hours.weekly.monday = { open: "11:00", close: "11:00" }), "hours.weekly.monday"],
  // Exceptions: real dates, at most once, hours checked too (new: they had no pattern check)
  [
    "impossible date",
    (c) => (c.hours.exceptions = [{ date: "2026-02-30", note: { sv: "Stängt", en: "Closed" }, hours: null }]),
    "hours.exceptions.0.date",
  ],
  [
    "duplicate exception date",
    (c) => {
      const e = { date: "2026-12-24", note: { sv: "Julafton", en: "Christmas Eve" }, hours: null };
      c.hours.exceptions = [e, { ...e }];
    },
    "hours.exceptions",
  ],
  [
    "exception with blank hours",
    (c) =>
      (c.hours.exceptions = [{ date: "2026-12-31", note: { sv: "Nyår", en: "New Year" }, hours: { open: "", close: "" } }]),
    "hours.exceptions.0.hours.open",
  ],
  // Booking settings consistent with their mode
  ["unknown booking mode", (c) => (c.settings.booking.provider = "phone"), "settings.booking.provider"],
  ["link mode without https URL", (c) => (c.settings.booking = { provider: "link", bookingUrl: "http://x.se" }), "settings.booking.bookingUrl"],
  ["embed mode without code", (c) => (c.settings.booking = { provider: "embed", embedCode: " " }), "settings.booking.embedCode"],
  // Contact formats
  ["email without a domain", (c) => (c.settings.email = "hej@"), "settings.email"],
  ["phone with letters", (c) => (c.settings.phone = "ring oss"), "settings.phone"],
  ["http social link", (c) => (c.settings.socialLinks.instagram = "http://instagram.com/x"), "settings.socialLinks.instagram"],
  ["map that is not https", (c) => (c.settings.mapEmbed = "javascript:alert(1)"), "settings.mapEmbed"],
  // Theme: hex colours, and exactly the keys the templates use (reviewer M7)
  ["three-digit colour", (c) => (c.theme.colors.primary = "#abc"), "theme.colors.primary"],
  ["theme colour missing", (c) => delete c.theme.colors.heroBg, "theme.colors.heroBg"],
  ["font stack with CSS injection", (c) => (c.theme.fonts.body = "x; } body { display:none"), "theme.fonts.body"],
  // Unknown keys are errors
  ["unknown field on a dish", (c) => (firstItem(c).spicy = true), "menu.categories.0.items.0"],
];

describe("the schema rejects", () => {
  it.each(cases)("%s", (_rule, mutate, path) => {
    expect(issuesAfter(mutate)).toContain(path);
  });
});
