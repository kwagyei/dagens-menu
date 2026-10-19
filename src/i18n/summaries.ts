/**
 * The history page's summaries in the owner's language (tester M5.6 D2 / M5.7 D6). Audit
 * summaries are stored once, in English, as the code writes them; the Swedish admin translates
 * the fixed phrases when it shows them. Names, emails, dates, prices, notes and photo
 * descriptions are the owner's own words and pass through untouched. A summary no rule
 * recognises (an older or newer format) is shown as stored, as the page already does for
 * unknown entities.
 *
 * Each rule applies only to the entities that write it, and matches the subject greedily (up
 * to the last ": "), so owner text that happens to contain a phrase ("Jul: added at noon" in an
 * hours note, a dish named "settings") is never rewritten (tester, 18 Oct). Every phrase here
 * mirrors one written in src/db, src/auth or scripts/seed.ts; summaries.test.ts lists them.
 */
import { t } from "./index";

type Locale = "sv" | "en";
type Rule = [entities: readonly string[] | null, pattern: RegExp, translate: (m: RegExpMatchArray, entity: string) => string];

// A dish and a category are common gender ("tillagd"), a photo is neuter ("tillagt").
const neuter = (entity: string) => entity === "image" || entity === "gallery_image";
const done = (entity: string, common: string, neuterForm: string) => (neuter(entity) ? neuterForm : common);
const direction = (d: string, entity: string) => `${done(entity, "flyttad", "flyttat")} ${d === "up" ? "upp" : "ned"}`;

const DAYS: Record<string, string> = { mon: "mån", tue: "tis", wed: "ons", thu: "tor", fri: "fre", sat: "lör", sun: "sön" };
const closed = (hours: string) => (hours === "closed" ? "stängt" : hours);
// formatPrice: digits with (no-break) spaces, optional öre, then "kr".
const PRICE = String.raw`\d[\d\s\u00a0\u202f]*(?:,\d\d)?[\s\u00a0\u202f]kr`;
const SLOTS = ["hero", "cta", "menu_hero", "story", "kitchen"] as const;
const slotName = (slot: string) => {
  const name = (SLOTS as readonly string[]).includes(slot) ? t("sv", `admin.photos.slot.${slot as (typeof SLOTS)[number]}`) : slot;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

// The fields a dish or Texts save can name, as they are stored.
const FIELDS: Record<string, string> = {
  name: "namn",
  description: "beskrivning",
  tags: "märkning",
  allergens: "allergener",
  "back on the menu": "tillbaka på menyn",
  "taken off the menu": "borttagen från menyn",
  "saved without changes": "sparad utan ändringar",
  tagline: "kort beskrivning",
  cuisine: "typ av kök",
  address: "adress",
  phone: "telefon",
  email: "e-post",
  socialLinks: "sociala medier",
  homeTagline: "startsidans rubrik",
  pullQuote: "citat",
  aboutStory: "vår historia",
  aboutChef: "om kocken",
};
const PRICE_CHANGE = new RegExp(`^price (${PRICE}) → (${PRICE})$`);
const field = (f: string) => FIELDS[f] ?? (PRICE_CHANGE.test(f) ? f.replace(/^price /, "pris ") : null);
/** A comma-separated list of known fields, translated; null if any part isn't one. */
const fieldList = (list: string) => {
  const parts = list.split(", ").map(field);
  return parts.every((p) => p !== null) ? parts.join(", ") : null;
};

const DISH = ["menu_item"];
const CATEGORY = ["menu_category"];
const PHOTO = ["image"];
const GALLERY = ["gallery_image"];

const RULES: Rule[] = [
  // Dishes and categories
  [DISH, new RegExp(`^(.*): added at (${PRICE})$`), (m) => `${m[1]}: tillagd för ${m[2]}`],
  [DISH, /^(.*): shown on the home page$/, (m) => `${m[1]}: visas på startsidan`],
  [DISH, /^(.*): no longer on the home page$/, (m) => `${m[1]}: inte längre på startsidan`],
  [DISH, /^(.*): sold out (\d{4}-\d\d-\d\d)$/, (m) => `${m[1]}: slutsåld ${m[2]}`],
  [DISH, /^(.*): back on sale$/, (m) => `${m[1]}: finns igen`],
  [DISH, /^(.*): photo (removed|changed)$/, (m) => `${m[1]}: foto ${m[2] === "removed" ? "borttaget" : "bytt"}`],
  [CATEGORY, /^(.*): category added$/, (m) => `${m[1]}: kategori tillagd`],
  [CATEGORY, /^(.*): deleted with (\d+) dish(?:es)?$/, (m) => `${m[1]}: borttagen med ${m[2]} ${m[2] === "1" ? "rätt" : "rätter"}`],
  [CATEGORY, /^(.*): renamed to (.*)$/, (m) => `${m[1]}: nytt namn ${m[2]}`],
  [[...DISH, ...CATEGORY], /^(.*): moved (up|down)$/, (m, e) => `${m[1]}: ${direction(m[2], e)}`],
  [[...DISH, ...CATEGORY, ...PHOTO], /^(.*): deleted$/, (m, e) => `${m[1]}: ${done(e, "borttagen", "borttaget")}`],
  [DISH, /^(.*): restored$/, (m) => `${m[1]}: återställd`],
  // Photos and the gallery
  [PHOTO, /^(.*): description changed$/, (m) => `${m[1]}: beskrivningen ändrad`],
  [PHOTO, /^uploaded a photo \((\d+ × \d+)\): (.*)$/s, (m) => `laddade upp ett foto (${m[1]}): ${m[2]}`],
  [PHOTO, /^Deleted (\d+) unused photo\(s\)$/, (m) => (m[1] === "1" ? "1 oanvänt foto borttaget" : `${m[1]} oanvända foton borttagna`)],
  [GALLERY, /^Gallery photo moved (up|down)$/, (m) => `Galleriets foto ${direction(m[1], "image")}`],
  [GALLERY, /^(.*): added to the gallery$/, (m) => `${m[1]}: tillagt i galleriet`],
  [GALLERY, /^(.*): removed from the gallery$/, (m) => `${m[1]}: borttaget från galleriet`],
  [["page_content"], /^Page photo (\w+): (removed|changed)$/, (m) => `${slotName(m[1])}: ${m[2] === "removed" ? "borttaget" : "bytt"}`],
  // The site as a whole
  [["site"], /^Content loaded from JSON$/, () => "Innehåll inläst från JSON"],
  [["site"], /^Restored from (.+) \(exported (.+)\)$/, (m) => `Återställt från ${m[1]} (exporterat ${m[2]})`],
  [["audit_log"], /^history older than (\d+) days removed: (\d+) entr(?:y|ies)$/, (m) => `historik äldre än ${m[1]} dagar borttagen: ${m[2]} ${m[2] === "1" ? "post" : "poster"}`],
  [null, /^deploy check$/, () => "driftkontroll"],
  // Hours: the note in brackets is the owner's
  [["hours_exception"], /^(\d{4}-\d\d-\d\d): exception removed$/, (m) => `${m[1]}: avvikande dag borttagen`],
  [["hours_exception"], /^(\d{4}-\d\d-\d\d): (closed|\d\d:\d\d–\d\d:\d\d) \((.*)\)$/s, (m) => `${m[1]}: ${closed(m[2])} (${m[3]})`],
  [
    ["hours"],
    /^weekly hours: (.+)$/,
    (m) =>
      `öppettider: ${m[1]
        .split(", ")
        .map((c) => c.replace(/^(\w{3}) (\S+) → (\S+)$/, (_, d: string, a: string, b: string) => `${DAYS[d] ?? d} ${closed(a)} → ${closed(b)}`))
        .join(", ")}`,
  ],
  // Security: who it concerns is an email, which stays
  [["invite"], /^(.*): invited as owner; link valid (\d+) hours$/, (m) => `${m[1]}: inbjuden som ägare; länken gäller i ${m[2]} timmar`],
  [
    ["invite"],
    /^(.*): invited again \(recovery\), already has a passkey; link valid (\d+) hours$/,
    (m) => `${m[1]}: inbjuden igen (återställning), har redan en passkey; länken gäller i ${m[2]} timmar`,
  ],
  [["invite", "passkey"], /^(.*): first passkey created from the invite$/, (m) => `${m[1]}: första passkeyn skapad med inbjudan`],
  [
    ["invite", "passkey"],
    /^(.*): passkey created from a new invite \(recovery\); passkeys now: (\d+)$/,
    (m) => `${m[1]}: passkey skapad med ny inbjudan (återställning); passkeys nu: ${m[2]}`,
  ],
  [["invite", "passkey"], /^(.*): passkey created from an invite$/, (m) => `${m[1]}: passkey skapad med inbjudan`],
  [["passkey"], /^(.*): another device's passkey added$/, (m) => `${m[1]}: passkey för en annan enhet tillagd`],
  [["passkey"], /^(.*): passkey from (\d{4}-\d\d-\d\d) removed; sign-ins ended: (\d+)$/, (m) => `${m[1]}: passkey från ${m[2]} borttagen; avslutade inloggningar: ${m[3]}`],
  [["sessions"], /^(.*): signed out everywhere; sign-ins ended: (\d+)$/, (m) => `${m[1]}: utloggad överallt; avslutade inloggningar: ${m[2]}`],
  [["membership"], /^(.*): access revoked; passkeys removed: (\d+)$/, (m) => `${m[1]}: åtkomst återkallad; borttagna passkeys: ${m[2]}`],
];

// A saved form: "<subject>: <field>, <field>, …". The subject is the dish's name, or for Texts a
// fixed word; the last ": " splits them, since a field list never contains one.
const SAVES: Record<string, (subject: string) => string> = {
  menu_item: (subject) => subject,
  settings: (subject) => (subject === "settings" ? "restaurangen" : subject),
  page_content: (subject) => (subject === "page texts" ? "sidornas texter" : subject),
};

/** A summary as the history page shows it in `locale`; `entity` is the audit row's. */
export function localizedSummary(summary: string, entity: string, locale: Locale): string {
  if (locale !== "sv") return summary;
  for (const [entities, pattern, translate] of RULES) {
    if (entities && !entities.includes(entity)) continue;
    const m = summary.match(pattern);
    if (m) return translate(m, entity);
  }
  const save = Object.hasOwn(SAVES, entity) ? summary.match(/^(.*): (.+)$/s) : null;
  if (save) {
    const list = fieldList(save[2]);
    if (list !== null) return `${SAVES[entity](save[1])}: ${list}`;
  }
  return summary;
}
