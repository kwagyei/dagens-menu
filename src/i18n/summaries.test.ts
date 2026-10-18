import { describe, expect, it } from "vitest";
import { localizedSummary } from "./summaries";

const sv = (summary: string, entity = "menu_item") => localizedSummary(summary, entity, "sv");

describe("history summaries in Swedish (tester M5.6 D2 / M5.7 D6)", () => {
  it.each([
    // Each phrase as src/db and src/auth write it, and what the Swedish admin shows.
    ["Toast Skagen: added at 135 kr", "Toast Skagen: tillagd för 135 kr"],
    ["Toast Skagen: shown on the home page", "Toast Skagen: visas på startsidan"],
    ["Toast Skagen: no longer on the home page", "Toast Skagen: inte längre på startsidan"],
    ["Köttbullar: moved up", "Köttbullar: flyttad upp"],
    ["Köttbullar: moved down", "Köttbullar: flyttad ned"],
    ["Lunch: category added", "Lunch: kategori tillagd"],
    ["Lunch: renamed to Dagens lunch", "Lunch: nytt namn Dagens lunch"],
    ["Lunch: deleted with 1 dish", "Lunch: borttagen med 1 rätt"],
    ["Lunch: deleted with 3 dishes", "Lunch: borttagen med 3 rätter"],
    ["Pannbiff: deleted", "Pannbiff: borttagen"],
    ["Dagens soppa: sold out 2026-10-18", "Dagens soppa: slutsåld 2026-10-18"],
    ["Dagens soppa: back on sale", "Dagens soppa: finns igen"],
    ["Köttbullar: photo changed", "Köttbullar: foto bytt"],
    ["Köttbullar: photo removed", "Köttbullar: foto borttaget"],
    ["Page photo hero: changed", "Sidfoto (hero): bytt"],
    ["Köttbullar: price 195 kr → 205 kr, name, description", "Köttbullar: pris 195 kr → 205 kr, namn, beskrivning"],
    ["Köttbullar: tags, allergens, taken off the menu", "Köttbullar: märkning, allergener, borttagen från menyn"],
    ["Köttbullar: back on the menu", "Köttbullar: tillbaka på menyn"],
    ["Köttbullar: saved without changes", "Köttbullar: sparad utan ändringar"],
    ["settings: phone, socialLinks", "restaurangen: telefon, sociala medier"],
    ["page texts: homeTagline, aboutStory", "sidornas texter: startsidans rubrik, vår historia"],
    ["page texts: saved without changes", "sidornas texter: sparad utan ändringar"],
    ["weekly hours: mon 11:00–22:00 → closed, sat closed → 12:00–23:00", "öppettider: mån 11:00–22:00 → stängt, lör stängt → 12:00–23:00"],
    ["2026-12-24: closed (Julafton)", "2026-12-24: stängt (Julafton)"],
    ["2026-12-31: 12:00–18:00 (Nyårsafton)", "2026-12-31: 12:00–18:00 (Nyårsafton)"],
    ["2026-12-24: exception removed", "2026-12-24: avvikande dag borttagen"],
    ["Content loaded from JSON", "Innehåll inläst från JSON"],
    ["deploy check", "driftkontroll"],
    ["history older than 180 days removed: 12 entries", "historik äldre än 180 dagar borttagen: 12 poster"],
    ["history older than 180 days removed: 1 entry", "historik äldre än 180 dagar borttagen: 1 post"],
    ["a@b.se: invited as owner; link valid 72 hours", "a@b.se: inbjuden som ägare; länken gäller i 72 timmar"],
    ["a@b.se: invited again (recovery), already has a passkey; link valid 72 hours", "a@b.se: inbjuden igen (återställning), har redan en passkey; länken gäller i 72 timmar"],
    ["a@b.se: first passkey created from the invite", "a@b.se: första passkeyn skapad med inbjudan"],
    ["a@b.se: passkey created from a new invite (recovery); passkeys now: 2", "a@b.se: passkey skapad med ny inbjudan (återställning); passkeys nu: 2"],
    ["a@b.se: passkey created from an invite", "a@b.se: passkey skapad med inbjudan"],
    ["a@b.se: another device's passkey added", "a@b.se: passkey för en annan enhet tillagd"],
    ["a@b.se: passkey from 2026-10-16 removed; sign-ins ended: 2", "a@b.se: passkey från 2026-10-16 borttagen; avslutade inloggningar: 2"],
    ["a@b.se: signed out everywhere; sign-ins ended: 3", "a@b.se: utloggad överallt; avslutade inloggningar: 3"],
    ["a@b.se: access revoked; passkeys removed: 1", "a@b.se: åtkomst återkallad; borttagna passkeys: 1"],
  ])("%s", (stored, shown) => {
    expect(sv(stored)).toBe(shown);
  });

  it("uses the neuter form for photos", () => {
    expect(sv("Köttbullar med lingon: deleted", "image")).toBe("Köttbullar med lingon: borttaget");
    expect(sv("Gallery photo moved down", "gallery_image")).toBe("Galleriets foto flyttat ned");
    expect(sv("Rökt lax: added to the gallery", "gallery_image")).toBe("Rökt lax: tillagt i galleriet");
    expect(sv("Rökt lax: removed from the gallery", "gallery_image")).toBe("Rökt lax: borttaget från galleriet");
    expect(sv("Rökt lax: description changed", "image")).toBe("Rökt lax: beskrivningen ändrad");
    expect(sv("Deleted 4 unused photo(s)", "image")).toBe("4 oanvända foton borttagna");
    expect(sv("uploaded a photo (1600 × 2133): Sample photo", "image")).toBe("laddade upp ett foto (1600 × 2133): Sample photo");
  });

  it("never touches the owner's words: a dish named like a phrase stays as it is", () => {
    expect(sv("Moved: deleted")).toBe("Moved: borttagen");
    expect(sv("Kroppkakor: back on sale")).toBe("Kroppkakor: finns igen");
    expect(sv("name: name")).toBe("name: namn");
  });

  it("leaves a summary it doesn't recognise as stored", () => {
    for (const s of ["something new happened", "Köttbullar: grilled instead", "", "limit-abc-01"]) expect(sv(s)).toBe(s);
  });

  it("shows English as stored", () => {
    expect(localizedSummary("Köttbullar: moved up", "menu_item", "en")).toBe("Köttbullar: moved up");
  });
});
