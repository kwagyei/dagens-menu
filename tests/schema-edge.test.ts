/**
 * Tester's edge cases for siteContentSchema, beyond tests/schema-parity.test.ts.
 * Each case mutates a copy of the real bistro content. Expectations follow ADR-011 §8
 * and plan M1.2 / M1.5; a failing case is a reported disagreement, not a spec change.
 */
import { describe, expect, it } from "vitest";
import { siteContentSchema } from "../src/content/schema";
import { readSiteJson } from "./site-fixtures";

type Content = ReturnType<typeof readSiteJson>;
const SITE = "bistro";
const base = readSiteJson(SITE);

function parse(mutate: (c: Content) => void) {
  const copy = structuredClone(base);
  mutate(copy);
  return siteContentSchema(SITE).safeParse(copy);
}
const firstItem = (c: Content) => c.menu.categories[0].items[0];

describe("text that looks non-empty but is not", () => {
  it.each([
    ["zero-width space", "​"],
    ["word joiner", "⁠"],
    ["zero-width joiner + non-joiner", "‍‌"],
    ["C1 control character", "\u0085\u009F"],
    ["no-break space only", "  "],
    ["byte-order mark", "﻿"],
  ])("rejects a dish name that is only a %s", (_n, value) => {
    expect(parse((c) => (firstItem(c).name.en = value)).success).toBe(false);
  });

  it("strips C1 control characters (ADR-011 §8: control characters stripped)", () => {
    const r = parse((c) => (firstItem(c).name.en = "Soup\u0085"));
    expect(r.success && r.data.menu.categories[0].items[0].name.en).toBe("Soup");
  });

  it("strips bidi override characters that can spoof a displayed price or name", () => {
    const r = parse((c) => (firstItem(c).name.en = "Soup‮99"));
    expect(r.success && r.data.menu.categories[0].items[0].name.en).toBe("Soup99");
  });

  it("counts a dish name of 41 emoji (82 UTF-16 units) as 41 characters", () => {
    expect(parse((c) => (firstItem(c).name.en = "🍲".repeat(41))).success).toBe(true);
  });

  it("composes decomposed å before measuring length", () => {
    const decomposed = "å".repeat(80); // 160 code units, 80 characters after NFC
    expect(parse((c) => (firstItem(c).name.sv = decomposed)).success).toBe(true);
  });
});

describe("prototype keys from JSON", () => {
  it("rejects __proto__ as a social link name", () => {
    const r = parse((c) => {
      c.settings.socialLinks = JSON.parse('{"__proto__": "https://evil.example"}');
    });
    expect(r.success).toBe(false);
  });

  it("rejects __proto__ in highlightImages", () => {
    const r = parse((c) => {
      c.pages.home.highlightImages = JSON.parse('{"__proto__": "/images/bistro/x.jpg"}');
    });
    expect(r.success).toBe(false);
  });

  it("rejects __proto__ as an unknown key on a strict object", () => {
    const r = parse((c) => {
      c.menu.categories[0].items[0] = { ...firstItem(c), ...JSON.parse('{"__proto__": {"available": false}}') };
    });
    expect(r.success).toBe(false);
  });

  it("does not let a parsed record pollute Object.prototype", () => {
    parse((c) => {
      c.settings.socialLinks = JSON.parse('{"__proto__": {"polluted": "https://x"}}');
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("dates and times", () => {
  const exception = (date: string) => (c: Content) =>
    (c.hours.exceptions = [{ date, note: { sv: "Stängt", en: "Closed" }, hours: null }]);

  it("accepts a leap day in a leap year", () => {
    expect(parse(exception("2028-02-29")).success).toBe(true);
  });
  it("rejects 24:00 (HH:MM 24-hour means 00:00–23:59)", () => {
    expect(parse((c) => (c.hours.weekly.monday = { open: "11:00", close: "24:00" })).success).toBe(false);
  });
  it("accepts closing at 00:00 after an 11:00 opening (after midnight)", () => {
    expect(parse((c) => (c.hours.weekly.monday = { open: "11:00", close: "00:00" })).success).toBe(true);
  });
  it("rejects a time with seconds or a single-digit hour", () => {
    expect(parse((c) => (c.hours.weekly.monday = { open: "9:00", close: "17:00" })).success).toBe(false);
    expect(parse((c) => (c.hours.weekly.monday = { open: "09:00:00", close: "17:00" })).success).toBe(false);
  });
  it("rejects exception date 0000-01-01", () => {
    expect(parse(exception("0000-01-01")).success).toBe(false);
  });
  it("rejects exception date 9999-12-31 (outside the accepted year range; the two-year rule belongs to the admin save path)", () => {
    expect(parse(exception("9999-12-31")).success).toBe(false);
  });
});

describe("highlights (plan M1.5: unavailable items are skipped)", () => {
  it("still builds when a highlighted dish is marked unavailable", () => {
    const r = parse((c) => {
      const id = c.pages.home.highlights[0];
      for (const cat of c.menu.categories) for (const i of cat.items) if (i.id === id) i.available = false;
    });
    expect(r.success).toBe(true);
  });
});

describe("size", () => {
  it("handles a 20 000-item menu without hanging", () => {
    const start = performance.now();
    parse((c) => {
      const template = firstItem(c);
      c.menu.categories[0].items = Array.from({ length: 20_000 }, (_, n) => ({
        ...structuredClone(template),
        id: n.toString(36).padStart(12, "0"),
      }));
    });
    // About 2 s on a laptop; a quadratic check would take minutes. The margin is for busy CI runners.
    expect(performance.now() - start).toBeLessThan(20_000);
  }, 30_000);
});

describe("other formats", () => {
  it("rejects a phone number that is only dashes", () => {
    expect(parse((c) => (c.settings.phone = "-------")).success).toBe(false);
  });
  it("rejects an image path that is the parent directory", () => {
    expect(parse((c) => (c.pages.home.heroImage = "/images/bistro/..")).success).toBe(false);
  });
  it("rejects an https URL with no host", () => {
    expect(parse((c) => (c.settings.socialLinks.instagram = "https://")).success).toBe(false);
  });
});
