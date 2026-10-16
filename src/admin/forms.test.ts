import { describe, expect, it } from "vitest";
import { kronorText, parseCategoryForm, parseExceptionForm, parseHoursForm, parseItemForm, rowVersionOf } from "./forms";

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
    expect(parsed.errors.wednesday).toBe("Öppnar och stänger samma tid.");
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
