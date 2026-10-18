/**
 * The Swedish history's summaries (src/i18n/summaries.ts) against what the
 * code actually writes, and against owner text that looks like a fixed phrase.
 */
import { describe, expect, it } from "vitest";
import { formatPrice } from "../src/content/load";
import { localizedSummary } from "../src/i18n/summaries";

const sv = (summary: string, entity = "menu_item") => localizedSummary(summary, entity, "sv");

describe("summaries as the code formats them", () => {
  it("translates a price change written with formatPrice's no-break spaces", () => {
    const stored = `Köttbullar: price ${formatPrice(125000)} → ${formatPrice(14550)}, name`;
    expect(sv(stored)).toBe(`Köttbullar: pris ${formatPrice(125000)} → ${formatPrice(14550)}, namn`);
  });

  it("translates a dish added at a price with no-break spaces", () => {
    expect(sv(`Toast: added at ${formatPrice(13500)}`)).toBe(`Toast: tillagd för ${formatPrice(13500)}`);
  });

  it("translates a restore's summary (scripts/seed.ts --from)", () => {
    expect(sv("Restored from bistro-2026-10-18.json (exported 2026-10-18T10:00:00Z)", "site")).not.toMatch(/^Restored from/);
  });

  it("uses the singular for one unused photo", () => {
    expect(sv("Deleted 1 unused photo(s)", "image")).toBe("1 oanvänt foto borttaget");
  });

  it("names page photo slots in Swedish, not by their code id", () => {
    expect(sv("Page photo menu_hero: changed", "page_content")).not.toContain("menu_hero");
  });
});

describe("owner text that looks like a fixed phrase", () => {
  it("does not show an edit as an addition when the dish name contains ': added at '", () => {
    // Dish "Fisk: added at sea" edited: describeChange writes "<name>: name".
    expect(sv("Fisk: added at sea: name")).not.toContain("tillagd");
  });

  it("does not show a category deletion as a rename when its name contains ': renamed to '", () => {
    expect(sv("A: renamed to B: deleted with 2 dishes", "menu_category")).toBe("A: renamed to B: borttagen med 2 rätter");
  });

  it("does not turn an hours exception's note into an addition", () => {
    expect(sv("2026-12-24: closed (Jul: added at noon)", "hours_exception")).toBe("2026-12-24: stängt (Jul: added at noon)");
  });

  it("does not call a dish named 'settings' the restaurant", () => {
    expect(sv("settings: name", "menu_item")).not.toContain("restaurangen");
    expect(sv("page texts: description", "menu_item")).not.toContain("sidornas texter");
  });

  it("translates a save of a dish whose name contains ': '", () => {
    expect(sv("Lunch: Fisk: name, tags")).toBe("Lunch: Fisk: namn, märkning");
  });

  it("leaves a dish name that is itself a field name as the owner wrote it", () => {
    expect(sv("Tags: tags")).toBe("Tags: märkning");
    expect(sv("Moved up: deleted")).toBe("Moved up: borttagen");
    expect(sv("Pasta: moved up: sold out 2026-10-18")).toBe("Pasta: moved up: slutsåld 2026-10-18");
  });

  it("passes markup through unchanged (escaping is the page's job)", () => {
    expect(sv("<img src=x onerror=alert(1)>: deleted")).toBe("<img src=x onerror=alert(1)>: borttagen");
  });
});

describe("gender", () => {
  it.each([
    ["Lunch: moved up", "menu_category", "Lunch: flyttad upp"],
    ["Lunch: deleted with 0 dishes", "menu_category", "Lunch: borttagen med 0 rätter"],
    ["Rökt lax: deleted", "image", "Rökt lax: borttaget"],
    ["Pannbiff: deleted", "menu_item", "Pannbiff: borttagen"],
  ])("%s (%s)", (stored, entity, shown) => {
    expect(sv(stored, entity)).toBe(shown);
  });
});

describe("English", () => {
  it("leaves every summary as stored", () => {
    for (const s of ["Pannbiff: deleted", "settings: phone", "Deleted 1 unused photo(s)"]) expect(localizedSummary(s, "menu_item", "en")).toBe(s);
  });
});
