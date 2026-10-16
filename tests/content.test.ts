/**
 * Validates every demo site's content against the rules the templates rely on.
 *
 * Owners edit this JSON through Decap CMS, and Decap's own validation is shallow — it will
 * happily save an empty English translation or a close time of "25:00". These tests run in
 * CI on every change, so a bad edit fails the pull request instead of reaching the live site.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLERGENS, BOOKING_MODES, MENU_TAGS } from "../scripts/content-vocabulary.mjs";
import type { Gallery, Menu, OpeningHours, Pages, SiteSettings, Theme } from "../src/content/load";

const sitesDir = resolve(import.meta.dirname, "..", "sites");
const sites = readdirSync(sitesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function load<T>(site: string, file: string): T {
  return JSON.parse(readFileSync(resolve(sitesDir, site, file), "utf-8")) as T;
}

/** Every `{ sv, en }` object anywhere in a value, with a dotted path for error messages. */
function localizedFields(value: unknown, path = ""): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) return value.flatMap((v, i) => localizedFields(v, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  if ("sv" in obj || "en" in obj) return [[path, obj]];
  return Object.entries(obj).flatMap(([k, v]) => localizedFields(v, path ? `${path}.${k}` : k));
}

function isValidDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso);
}

it("finds the demo sites", () => {
  expect(sites).toEqual(expect.arrayContaining(["bistro", "westafrican"]));
});

describe.each(sites)("%s", (site) => {
  const settings = load<SiteSettings>(site, "content/settings.json");
  const menu = load<Menu>(site, "content/menu.json");
  const hours = load<OpeningHours>(site, "content/hours.json");
  const pages = load<Pages>(site, "content/pages.json");
  const gallery = load<Gallery>(site, "content/gallery.json");
  const theme = load<Theme>(site, "theme.json");

  it("translates every text field into both Swedish and English", () => {
    const content = { settings, menu, hours, pages, gallery };
    const fields = localizedFields(content);
    expect(fields.length).toBeGreaterThan(0);
    for (const [path, field] of fields) {
      expect(Object.keys(field).sort(), path).toEqual(["en", "sv"]);
      for (const lang of ["sv", "en"]) {
        expect(typeof field[lang], `${path}.${lang}`).toBe("string");
        expect((field[lang] as string).trim(), `${path}.${lang}`).not.toBe("");
      }
    }
  });

  describe("menu", () => {
    const items = menu.categories.flatMap((c) => c.items.map((item, i) => ({ path: `${c.id}-${i}`, item })));

    it("has unique, URL-safe category ids", () => {
      const ids = menu.categories.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("prices every item as a non-negative whole number of öre", () => {
      for (const { path, item } of items) {
        expect(Number.isSafeInteger(item.price) && item.price >= 0, `${path}: ${item.price}`).toBe(true);
      }
    });

    it("uses only the tags and EU allergens the CMS offers", () => {
      for (const { path, item } of items) {
        for (const tag of item.tags) expect(MENU_TAGS, path).toContain(tag);
        for (const allergen of item.allergens) expect(ALLERGENS, path).toContain(allergen);
        expect(new Set(item.allergens).size, `${path} duplicate allergen`).toBe(item.allergens.length);
        expect(typeof item.available, path).toBe("boolean");
      }
    });

    it("resolves every home-page highlight to a menu item", () => {
      const unresolved = pages.home.highlights.filter((id) => {
        const dash = id.lastIndexOf("-");
        const category = menu.categories.find((c) => c.id === id.slice(0, dash));
        return !category?.items[Number(id.slice(dash + 1))];
      });
      expect(unresolved).toEqual([]);
    });
  });

  describe("opening hours", () => {
    it("lists all seven weekdays and nothing else", () => {
      expect(Object.keys(hours.weekly).sort()).toEqual([...WEEKDAYS].sort());
    });

    it("uses 24-hour HH:MM times and never opens and closes at the same minute", () => {
      const slots = [
        ...Object.entries(hours.weekly).map(([day, h]) => [day, h] as const),
        ...hours.exceptions.map((e) => [e.date, e.hours] as const),
      ];
      for (const [label, h] of slots) {
        if (h === null) continue;
        expect(h.open, label).toMatch(TIME);
        expect(h.close, label).toMatch(TIME);
        // close < open is allowed: it means closing after midnight.
        expect(h.close, label).not.toBe(h.open);
      }
    });

    it("dates each exception with a real calendar date, at most once", () => {
      const dates = hours.exceptions.map((e) => e.date);
      for (const date of dates) expect(isValidDate(date), date).toBe(true);
      expect(new Set(dates).size).toBe(dates.length);
    });
  });

  describe("settings", () => {
    it("configures booking consistently with its mode", () => {
      expect(BOOKING_MODES).toContain(settings.booking.provider);
      if (settings.booking.provider === "link") {
        expect(settings.booking.bookingUrl).toMatch(/^https:\/\//);
      }
      if (settings.booking.provider === "embed") {
        expect(settings.booking.embedCode?.trim()).toBeTruthy();
      }
    });

    it("has a contactable email, phone and https social links", () => {
      expect(settings.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      expect(settings.phone).toMatch(/^\+?[\d\s-]{7,}$/);
      for (const url of Object.values(settings.socialLinks ?? {})) expect(url).toMatch(/^https:\/\//);
    });
  });

  it("defines every theme colour as a six-digit hex value", () => {
    for (const [name, value] of Object.entries(theme.colors)) {
      expect(value, name).toMatch(HEX_COLOUR);
    }
  });
});
