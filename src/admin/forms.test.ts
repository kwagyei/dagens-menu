import { describe, expect, it } from "vitest";
import { kronorText, parseCategoryForm, parseExceptionForm, parseHoursForm, parseItemForm, parsePageTextsForm, parseSettingsForm, rowVersionOf } from "./forms";

const form = (entries: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const value of [v].flat()) data.append(k, value);
  return data;
};
const valid = {
  name_sv: "Ärtsoppa",
  name_en: "Pea soup",
  description_sv: "Med fläsk",
  description_en: "With pork",
  price: "145:-",
  available: "on",
};

describe("parseItemForm", () => {
  it("turns a filled-in form into an edit, price in öre", () => {
    const parsed = parseItemForm(form({ ...valid, tags: ["vegan", "halal"], allergens: ["milk", "milk", "shellfish"] }), "sv");
    expect(parsed.errors).toEqual({});
    expect(parsed.edit).toEqual({
      name: { sv: "Ärtsoppa", en: "Pea soup" },
      description: { sv: "Med fläsk", en: "With pork" },
      priceOre: 14500,
      tags: ["vegan"],
      allergens: ["milk"],
      available: true,
    });
  });

  it("reads unticked checkboxes as false", () => {
    const parsed = parseItemForm(form({ ...valid, available: [] as unknown as string }), "sv");
    expect(parsed.edit?.available).toBe(false);
    expect(parsed.values.featured).toBe(false);
  });

  it("names every missing field, in the owner's language, and keeps what was typed", () => {
    const parsed = parseItemForm(form({ ...valid, name_en: "  ", description_sv: "​", price: "" }), "en");
    expect(parsed.edit).toBeNull();
    expect(parsed.errors).toEqual({
      name_en: "Please fill in this field.",
      description_sv: "Please fill in this field.",
      price: "Enter a price, for example 145.",
    });
    expect(parsed.values.name_sv).toBe("Ärtsoppa");
  });

  it("explains a price it can't read", () => {
    expect(parseItemForm(form({ ...valid, price: "1,250" }), "sv").errors.price).toMatch(/kronor och öre/);
    expect(parseItemForm(form({ ...valid, price: "gratis" }), "sv").errors.price).toMatch(/siffror/);
    expect(parseItemForm(form({ ...valid, price: "-5" }), "sv").errors.price).toMatch(/negativt/);
  });

  it("asks for confirmation of an unusual price, and accepts it once confirmed", () => {
    for (const price of ["5", "2500"]) {
      const unconfirmed = parseItemForm(form({ ...valid, price }), "sv");
      expect(unconfirmed.needsPriceConfirm).toBe(true);
      expect(unconfirmed.edit).toBeNull();
      expect(parseItemForm(form({ ...valid, price, confirm_price: "on" }), "sv").edit).not.toBeNull();
    }
  });

  it("limits lengths as a reader counts them", () => {
    expect(parseItemForm(form({ ...valid, name_sv: "x".repeat(81) }), "sv").errors.name_sv).toBe("Högst 80 tecken.");
    expect(parseItemForm(form({ ...valid, name_sv: "🍲".repeat(80) }), "sv").errors.name_sv).toBeUndefined();
  });
});

describe("parseCategoryForm", () => {
  it("needs both names", () => {
    expect(parseCategoryForm(form({ name_sv: "Dryck", name_en: "Drinks" }), "sv").name).toEqual({ sv: "Dryck", en: "Drinks" });
    expect(parseCategoryForm(form({ name_sv: "Dryck" }), "sv").errors).toEqual({ name_en: "Fyll i det här fältet." });
  });
});

describe("helpers", () => {
  it("shows öre as an owner would type kronor", () => {
    expect([kronorText(14500), kronorText(14550), kronorText(14505), kronorText(0)]).toEqual(["145", "145,50", "145,05", "0"]);
  });

  it("reads only a whole-number row version", () => {
    expect(rowVersionOf(form({ row_version: "3" }))).toBe(3);
    expect(rowVersionOf(form({ row_version: "3; DROP" }))).toBeNull();
    expect(rowVersionOf(form({}))).toBeNull();
  });
});

describe("parseHoursForm", () => {
  const week = (over: Record<string, string> = {}) => {
    const entries: Record<string, string> = {};
    for (const d of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
      entries[`${d}_open`] = "11:00";
      entries[`${d}_close`] = "22:00";
    }
    return form({ ...entries, sunday_closed: "on", ...over });
  };

  it("reads open days and closed days", () => {
    const parsed = parseHoursForm(week({ friday_close: "01:00" }), "sv");
    expect(parsed.errors).toEqual({});
    expect(parsed.weekly?.friday).toEqual({ open: "11:00", close: "01:00" });
    expect(parsed.weekly?.sunday).toBeNull();
  });

  it("needs both times unless the day is closed, and keeps what was typed", () => {
    const parsed = parseHoursForm(week({ monday_close: "", tuesday_open: "9", wednesday_close: "11:00", wednesday_open: "11:00" }), "sv");
    expect(parsed.weekly).toBeNull();
    expect(Object.keys(parsed.errors)).toEqual(["monday", "tuesday", "wednesday"]);
    expect(parsed.errors.wednesday).toBe("Öppnings- och stängningstiden är samma. Ändra en av dem.");
    expect(parsed.values.days.tuesday.open).toBe("9");
  });
});

describe("parseExceptionForm", () => {
  it("reads a closed holiday", () => {
    const parsed = parseExceptionForm(form({ date: "2026-12-24", closed: "on", note_sv: "Julafton", note_en: "Christmas Eve" }), "sv");
    expect(parsed.exception).toEqual({ date: "2026-12-24", hours: null, note: { sv: "Julafton", en: "Christmas Eve" } });
  });

  it("reads special hours and names what's missing", () => {
    expect(parseExceptionForm(form({ date: "2026-12-31", exception_open: "18:00", exception_close: "02:00", note_sv: "Nyår", note_en: "New Year" }), "en").exception?.hours).toEqual({ open: "18:00", close: "02:00" });
    const bad = parseExceptionForm(form({ date: "", note_sv: "Nyår" }), "en");
    expect(Object.keys(bad.errors)).toEqual(["date", "hours", "note_en"]);
  });
});

const settings = {
  name_sv: "Bistro Norden",
  name_en: "Bistro Norden",
  tagline_sv: "Husmanskost",
  tagline_en: "Home cooking",
  cuisine_sv: "Svensk",
  cuisine_en: "Swedish",
  address: "Storgatan 1, Stockholm",
  phone: " 08-123 456 78 ",
  email: "info@bistro.se",
  social_instagram: " https://instagram.com/bistronorden ",
  social_facebook: "",
};

describe("parseSettingsForm", () => {
  it("turns a filled-in form into settings, trimming contact details and dropping empty links", () => {
    const parsed = parseSettingsForm(form(settings), "sv");
    expect(parsed.errors).toEqual({});
    expect(parsed.settings).toMatchObject({ phone: "08-123 456 78", email: "info@bistro.se", socialLinks: { instagram: "https://instagram.com/bistronorden" } });
    expect(parsed.settings?.name).toEqual({ sv: "Bistro Norden", en: "Bistro Norden" });
  });

  it("rejects a non-https link, a bad phone and a bad email, in the owner's language, keeping the input", () => {
    const parsed = parseSettingsForm(form({ ...settings, social_tiktok: "http://tiktok.com/@x", phone: "08-12", email: "info@" }), "en");
    expect(parsed.settings).toBeNull();
    expect(parsed.errors).toEqual({
      phone: "Enter a phone number with at least seven digits, for example 08-123 456 78.",
      email: "Enter an email address, for example info@restaurant.se.",
      social_tiktok: "The link must start with https://.",
    });
    expect(parsed.values.social.tiktok).toBe("http://tiktok.com/@x");
  });

  it("rejects javascript: and other schemes as links", () => {
    for (const url of ["javascript:alert(1)", "instagram.com/x", "https://", "ftp://x.se"]) {
      expect(parseSettingsForm(form({ ...settings, social_instagram: url }), "sv").errors.social_instagram).toBe("Länken måste börja med https://.");
    }
  });

  it("keeps links to networks the form doesn't offer, and lets the form remove the ones it does", () => {
    const stored = { instagram: "https://instagram.com/old", mastodon: "https://mastodon.social/@bistro" };
    const parsed = parseSettingsForm(form({ ...settings, social_instagram: "" }), "sv", stored);
    expect(parsed.settings?.socialLinks).toEqual({ mastodon: "https://mastodon.social/@bistro" });
  });

  it("requires every text and caps its length", () => {
    const parsed = parseSettingsForm(form({ ...settings, name_en: " ", cuisine_sv: "x".repeat(81) }), "sv");
    expect(parsed.errors).toEqual({ name_en: "Fyll i det här fältet.", cuisine_sv: "Högst 80 tecken." });
  });
});

const texts = {
  home_tagline_sv: "Mat från trakten",
  home_tagline_en: "Local food",
  pull_quote_sv: "",
  pull_quote_en: "",
  about_story_sv: "Vi öppnade 2019.",
  about_story_en: "We opened in 2019.",
  about_chef_sv: "Anna lagar maten.",
  about_chef_en: "Anna cooks.",
};

describe("parsePageTextsForm", () => {
  it("reads the texts, with no pull quote when both are empty", () => {
    const parsed = parsePageTextsForm(form(texts), "sv");
    expect(parsed.errors).toEqual({});
    expect(parsed.texts).toEqual({
      homeTagline: { sv: "Mat från trakten", en: "Local food" },
      pullQuote: null,
      aboutStory: { sv: "Vi öppnade 2019.", en: "We opened in 2019." },
      aboutChef: { sv: "Anna lagar maten.", en: "Anna cooks." },
    });
  });

  it("needs the pull quote in both languages or neither", () => {
    const one = parsePageTextsForm(form({ ...texts, pull_quote_sv: "Bäst i stan", pull_quote_en: " ​" }), "sv");
    expect(one.errors).toEqual({ pull_quote_en: "Fyll i citatet på båda språken, eller töm båda." });
    expect(one.values.pull_quote_sv).toBe("Bäst i stan");
    expect(parsePageTextsForm(form({ ...texts, pull_quote_sv: "Bäst i stan", pull_quote_en: "Best in town" }), "sv").texts?.pullQuote).toEqual({ sv: "Bäst i stan", en: "Best in town" });
  });

  it("allows long about texts up to 3000 characters, not more", () => {
    expect(parsePageTextsForm(form({ ...texts, about_story_sv: "a".repeat(3000) }), "sv").errors).toEqual({});
    expect(parsePageTextsForm(form({ ...texts, about_story_sv: "a".repeat(3001), home_tagline_en: "" }), "en").errors).toEqual({
      about_story_sv: "At most 3000 characters.",
      home_tagline_en: "Please fill in this field.",
    });
  });
});
