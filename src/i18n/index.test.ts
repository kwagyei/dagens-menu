import { describe, expect, it } from "vitest";
import { SECURITY_EVENTS } from "../auth/audit";
import en from "./en";
import { fill, getLocale, localePath, t } from "./index";
import sv from "./sv";

describe("fill", () => {
  it("puts owner text in as it is, $ patterns included (review L4)", () => {
    for (const name of ["Pasta $' special", "$& co", "A $` B", "$$", "100 $1"]) expect(fill("{name} försvinner", { name })).toBe(`${name} försvinner`);
  });

  it("fills only its own values, never an inherited property such as {constructor}", () => {
    expect(fill("{constructor}", {})).toBe("{constructor}");
  });

  it("fills camel-case placeholders such as {limitMb}", () => {
    expect(fill("Högst {limitMb} MB", { limitMb: 5 })).toBe("Högst 5 MB");
  });

  it("fills several placeholders, numbers too, and leaves an unknown one alone", () => {
    expect(fill("{n} av {total}: {x}", { n: 2, total: 5 })).toBe("2 av 5: {x}");
  });
});

describe("getLocale", () => {
  it.each([
    ["https://x.se/", "sv"],
    ["https://x.se/meny/", "sv"],
    ["https://x.se/en/", "en"],
    ["https://x.se/en", "en"],
    ["https://x.se/en/menu/", "en"],
    // A Swedish page whose slug merely starts with "en" is still Swedish.
    ["https://x.se/enkel-meny/", "sv"],
  ])("%s → %s", (url, locale) => {
    expect(getLocale(new URL(url))).toBe(locale);
  });
});

describe("localePath", () => {
  it("leaves Swedish paths at the root", () => {
    expect(localePath("sv", "/menu/")).toBe("/menu/");
  });

  it("prefixes English paths and normalises a missing leading slash", () => {
    expect(localePath("en", "/menu/")).toBe("/en/menu/");
    expect(localePath("en", "menu/")).toBe("/en/menu/");
  });
});

describe("translations", () => {
  it("have the same keys in both languages", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(sv).sort());
  });

  it("have no empty strings", () => {
    for (const [key, value] of [...Object.entries(sv), ...Object.entries(en)]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("t() looks up the requested locale", () => {
    expect(t("en", "hours.today")).toBe("Today");
    expect(t("sv", "hours.today")).toBe("Idag");
  });
});

describe("allergen labels", () => {
  it("names every EU-14 allergen in both languages", async () => {
    const { ALLERGENS } = await import("../content/vocabulary");
    for (const allergen of ALLERGENS) {
      expect(sv[`allergen.${allergen}` as keyof typeof sv], allergen).toBeTruthy();
      expect(en[`allergen.${allergen}` as keyof typeof en], allergen).toBeTruthy();
    }
  });
});

describe("history labels for security events (reviewer M3)", () => {
  it.each(SECURITY_EVENTS.map((e) => [`${e.entity}.${e.action}`]))("%s has its own phrase in Swedish and English", (event) => {
    const key = `admin.history.event.${event}` as keyof typeof sv;
    expect(sv[key]).toBeTruthy();
    expect(en[key]).toBeTruthy();
    expect(t("sv", key)).not.toBe(t("en", key));
  });
});
