/**
 * The history page's summaries in the owner's language (tester M5.6 D2 / M5.7 D6). Audit
 * summaries are stored once, in English, as the code writes them; the Swedish admin translates
 * the fixed phrases when it shows them. Names, emails, dates, prices and photo descriptions are
 * the owner's own words and pass through untouched. A summary no rule recognises (an older or
 * newer format) is shown as stored, as the page already does for unknown entities.
 *
 * Every phrase here mirrors one written in src/db or src/auth; summaries.test.ts lists them.
 */
type Locale = "sv" | "en";

type Rule = [RegExp, (m: RegExpMatchArray, entity: string) => string];

// A dish and a category are common gender ("tillagd"), a photo is neuter ("tillagt").
const neuter = (entity: string) => entity === "image" || entity === "gallery_image";
const done = (entity: string, common: string, neuterForm: string) => (neuter(entity) ? neuterForm : common);
const direction = (d: string, entity: string) => `${done(entity, "flyttad", "flyttat")} ${d === "up" ? "upp" : "ned"}`;

const DAYS: Record<string, string> = { mon: "mån", tue: "tis", wed: "ons", thu: "tor", fri: "fre", sat: "lör", sun: "sön" };
const closed = (hours: string) => (hours === "closed" ? "stängt" : hours);

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
const field = (f: string) => FIELDS[f] ?? (/^price (.+) → (.+)$/.test(f) ? f.replace(/^price /, "pris ") : null);
/** A comma-separated list of known fields, translated; null if any part isn't one. */
const fieldList = (list: string) => {
  const parts = list.split(", ").map(field);
  return parts.every((p) => p !== null) ? parts.join(", ") : null;
};

const RULES: Rule[] = [
  // Content
  [/^(.*): added at (.+)$/, (m) => `${m[1]}: tillagd för ${m[2]}`],
  [/^(.*): shown on the home page$/, (m) => `${m[1]}: visas på startsidan`],
  [/^(.*): no longer on the home page$/, (m) => `${m[1]}: inte längre på startsidan`],
  [/^Gallery photo moved (up|down)$/, (m) => `Galleriets foto ${direction(m[1], "image")}`],
  [/^(.*): moved (up|down)$/, (m, e) => `${m[1]}: ${direction(m[2], e)}`],
  [/^(.*): category added$/, (m) => `${m[1]}: kategori tillagd`],
  [/^(.*): renamed to (.*)$/, (m) => `${m[1]}: nytt namn ${m[2]}`],
  [/^(.*): deleted with (\d+) dish(?:es)?$/, (m) => `${m[1]}: borttagen med ${m[2]} ${m[2] === "1" ? "rätt" : "rätter"}`],
  [/^(.*): deleted$/, (m, e) => `${m[1]}: ${done(e, "borttagen", "borttaget")}`],
  [/^(.*): sold out (\d{4}-\d\d-\d\d)$/, (m) => `${m[1]}: slutsåld ${m[2]}`],
  [/^(.*): back on sale$/, (m) => `${m[1]}: finns igen`],
  [/^(.*): photo (removed|changed)$/, (m) => `${m[1]}: foto ${m[2] === "removed" ? "borttaget" : "bytt"}`],
  [/^Page photo (\w+): (removed|changed)$/, (m) => `Sidfoto (${m[1]}): ${m[2] === "removed" ? "borttaget" : "bytt"}`],
  [/^(.*): description changed$/, (m) => `${m[1]}: beskrivningen ändrad`],
  [/^(.*): added to the gallery$/, (m) => `${m[1]}: tillagt i galleriet`],
  [/^(.*): removed from the gallery$/, (m) => `${m[1]}: borttaget från galleriet`],
  [/^uploaded a photo \((\d+ × \d+)\): (.*)$/, (m) => `laddade upp ett foto (${m[1]}): ${m[2]}`],
  [/^Deleted (\d+) unused photo\(s\)$/, (m) => `${m[1]} oanvända foton borttagna`],
  [/^Content loaded from JSON$/, () => "Innehåll inläst från JSON"],
  [/^deploy check$/, () => "driftkontroll"],
  [/^history older than (\d+) days removed: (\d+) entr(?:y|ies)$/, (m) => `historik äldre än ${m[1]} dagar borttagen: ${m[2]} ${m[2] === "1" ? "post" : "poster"}`],
  // Hours
  [/^(\d{4}-\d\d-\d\d): exception removed$/, (m) => `${m[1]}: avvikande dag borttagen`],
  [/^(\d{4}-\d\d-\d\d): (closed|\d\d:\d\d–\d\d:\d\d) \((.*)\)$/s, (m) => `${m[1]}: ${closed(m[2])} (${m[3]})`],
  [
    /^weekly hours: (.+)$/,
    (m) =>
      `öppettider: ${m[1]
        .split(", ")
        .map((c) => c.replace(/^(\w{3}) (\S+) → (\S+)$/, (_, d: string, a: string, b: string) => `${DAYS[d] ?? d} ${closed(a)} → ${closed(b)}`))
        .join(", ")}`,
  ],
  // Security: who it concerns is an email, which stays
  [/^(.*): invited as owner; link valid (\d+) hours$/, (m) => `${m[1]}: inbjuden som ägare; länken gäller i ${m[2]} timmar`],
  [/^(.*): invited again \(recovery\), already has a passkey; link valid (\d+) hours$/, (m) => `${m[1]}: inbjuden igen (återställning), har redan en passkey; länken gäller i ${m[2]} timmar`],
  [/^(.*): first passkey created from the invite$/, (m) => `${m[1]}: första passkeyn skapad med inbjudan`],
  [/^(.*): passkey created from a new invite \(recovery\); passkeys now: (\d+)$/, (m) => `${m[1]}: passkey skapad med ny inbjudan (återställning); passkeys nu: ${m[2]}`],
  [/^(.*): passkey created from an invite$/, (m) => `${m[1]}: passkey skapad med inbjudan`],
  [/^(.*): another device's passkey added$/, (m) => `${m[1]}: passkey för en annan enhet tillagd`],
  [/^(.*): passkey from (\d{4}-\d\d-\d\d) removed; sign-ins ended: (\d+)$/, (m) => `${m[1]}: passkey från ${m[2]} borttagen; avslutade inloggningar: ${m[3]}`],
  [/^(.*): signed out everywhere; sign-ins ended: (\d+)$/, (m) => `${m[1]}: utloggad överallt; avslutade inloggningar: ${m[2]}`],
  [/^(.*): access revoked; passkeys removed: (\d+)$/, (m) => `${m[1]}: åtkomst återkallad; borttagna passkeys: ${m[2]}`],
];

/** A summary as the history page shows it in `locale`. */
export function localizedSummary(summary: string, entity: string, locale: Locale): string {
  if (locale !== "sv") return summary;
  for (const [pattern, translate] of RULES) {
    const m = summary.match(pattern);
    if (m) return translate(m, entity);
  }
  // A saved dish or Texts form: "<name>: <field>, <field>, …" (the subject for Texts is fixed).
  const save = summary.match(/^(.*?): (.+)$/s);
  if (save) {
    const list = fieldList(save[2]);
    const subject = save[1] === "settings" ? "restaurangen" : save[1] === "page texts" ? "sidornas texter" : save[1];
    if (list !== null) return `${subject}: ${list}`;
  }
  return summary;
}
