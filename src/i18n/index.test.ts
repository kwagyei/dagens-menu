import { describe, expect, it } from "vitest";
import en from "./en";
import { getLocale, localePath, t } from "./index";
import sv from "./sv";

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
