/**
 * What a site's third-party embeds may load. The booking embed code is the operator's pasted
 * HTML; it must frame exactly one known provider (src/booking/presets), and the page's CSP
 * then allows that provider's origins as frames and nothing else. The map is an https iframe
 * URL, whose origin the CSP allows as a frame. Nothing loads before consent: the components
 * park both in a <template> until the visitor accepts.
 *
 * Providers run only inside a sandboxed, cross-origin <iframe>, never as a <script> on the
 * site's own origin (security review M1, 18 Oct): the admin shares that origin, so a provider
 * script could read an owner's form tokens and post as them. A framed provider can't reach the
 * page, its cookies or the admin, and the sandbox keeps it from navigating the page away.
 */
import { type BookingPreset, listPresets } from "./presets";

// Embed code is parsed into elements and attributes from these lists, and the page gets a
// fresh serialization of what was parsed, never the pasted text: anything the parser doesn't
// understand is refused rather than guessed at, since the CSP is derived from what's checked.
const VOID = new Set(["br"]);
const GLOBAL_ATTRS = new Set(["id", "class", "title", "style", "lang", "role", "aria-label"]);
// No `sandbox`: the page sets its own (SANDBOX), which pasted code can't loosen.
const TAG_ATTRS: Record<string, Set<string>> = {
  iframe: new Set(["src", "width", "height", "allow", "allowfullscreen", "loading", "referrerpolicy", "frameborder", "scrolling", "name"]),
  a: new Set(["href", "target", "rel"]),
  div: new Set(),
  span: new Set(),
  p: new Set(),
  br: new Set(),
};
// The attribute that names what the browser fetches, and must be the provider's.
const FETCHED_BY: Record<string, string> = { iframe: "src" };
// The browser reads nothing between <iframe> and its end tag as markup: it must be empty.
const RAW_TEXT = new Set(["iframe"]);
/**
 * What a framed provider may do: run its own script, keep its own origin (its cookies, never
 * this site's: the frame is cross-origin), submit its booking form and open a payment popup.
 * Not allow-top-navigation, so it can't send the visitor's page elsewhere.
 */
export const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

const START = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const END = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export type EmbedProvider = { id: string; preset: BookingPreset; html: string } | { problem: string };

const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
/** Character references as the browser reads them; anything else stays literal (and is re-escaped). */
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? whole;
    const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Why one attribute can't be used, or null. `value` is decoded. */
function attrProblem(tag: string, name: string, value: string | undefined): string | null {
  if (name.startsWith("on")) return `may not contain event handlers (${name})`;
  if (!GLOBAL_ATTRS.has(name) && !TAG_ATTRS[tag].has(name) && !/^data-[a-z0-9-]+$/.test(name)) return `may not use the ${name} attribute on <${tag}>`;
  if (name === "style" && /url\s*\(|expression|@import|\\|behavior/i.test(value ?? "")) return "may not load anything from a style attribute";
  if ((name === "src" || name === "href") && !originOf(value ?? "")) return `must use https:// URLs, got "${value ?? ""}"`;
  return null;
}

/** The one provider the embed code loads from, with the code as the page may hold it, or why it can't be used. */
export function embedProvider(code: string): EmbedProvider {
  const origins = new Set<string>();
  const open: string[] = [];
  let html = "";
  let rest = code;
  while (rest) {
    const text = /^[^<]+/.exec(rest)?.[0];
    if (text) {
      html += escape(decode(text));
      rest = rest.slice(text.length);
      continue;
    }
    const end = END.exec(rest);
    if (end) {
      const tag = end[1].toLowerCase();
      if (open.pop() !== tag) return { problem: `has a </${tag}> that closes nothing it opened` };
      html += `</${tag}>`;
      rest = rest.slice(end[0].length);
      continue;
    }
    const start = START.exec(rest);
    if (!start) return { problem: `has markup it can't read near ${JSON.stringify(rest.slice(0, 20))} (comments and other tags aren't allowed)` };
    const tag = start[1].toLowerCase();
    if (tag === "script" || tag === "link") return { problem: `may not contain <${tag}>: a booking provider runs only in its own <iframe>, never as a script on this site` };
    if (!(tag in TAG_ATTRS)) return { problem: `may not contain <${tag}>` };
    const attrs = new Map<string, string | undefined>();
    for (const [, rawName, dq, sq, bare] of start[2].matchAll(ATTR)) {
      const name = rawName.toLowerCase();
      if (attrs.has(name)) return { problem: `repeats the ${name} attribute on <${tag}>` };
      const value = dq ?? sq ?? bare;
      const decoded = value === undefined ? undefined : decode(value);
      const problem = attrProblem(tag, name, decoded);
      if (problem) return { problem };
      attrs.set(name, decoded);
    }
    const fetched = FETCHED_BY[tag];
    if (fetched) {
      const url = attrs.get(fetched);
      if (url === undefined) return { problem: `needs ${fetched} on <${tag}>` };
      origins.add(originOf(url)!);
    }
    if (tag === "iframe") attrs.set("sandbox", SANDBOX);
    html += `<${tag}${[...attrs].map(([name, value]) => (value === undefined ? ` ${name}` : ` ${name}="${escape(value)}"`)).join("")}>`;
    rest = rest.slice(start[0].length);
    if (VOID.has(tag)) continue;
    if (start[3]) return { problem: `may not self-close <${tag}/>, which the browser leaves open` };
    if (RAW_TEXT.has(tag)) {
      const close = new RegExp(`^\\s*</${tag}\\s*>`, "i").exec(rest);
      if (!close) return { problem: `must leave <${tag}> empty` };
      html += `</${tag}>`;
      rest = rest.slice(close[0].length);
      continue;
    }
    open.push(tag);
  }
  if (open.length > 0) return { problem: `leaves <${open.at(-1)}> open` };
  if (origins.size === 0) return { problem: "must frame a booking provider with <iframe src>" };

  for (const [id, preset] of Object.entries(listPresets())) {
    if (preset.mode === "embed" && [...origins].every((o) => preset.origins.includes(o))) return { id, preset, html };
  }
  return { problem: `must load from one known booking provider (src/booking/presets), got ${[...origins].join(", ")}` };
}

/** The third-party origins a site's public pages may use once the visitor consents. */
export interface ThirdPartyOrigins {
  /** The booking provider's origins, as frames only. */
  booking: string[];
  /** The map's origin, as a frame. */
  map: string[];
}

export function thirdPartyOrigins(settings: { booking: { provider: string; embedCode?: string }; mapEmbed: string }): ThirdPartyOrigins {
  let booking: string[] = [];
  if (settings.booking.provider === "embed" && settings.booking.embedCode) {
    const provider = embedProvider(settings.booking.embedCode);
    if ("preset" in provider) booking = provider.preset.origins;
  }
  const mapOrigin = settings.mapEmbed ? originOf(settings.mapEmbed) : undefined;
  return { booking, map: mapOrigin ? [mapOrigin] : [] };
}

/**
 * The embed code to place in the page, unescaped: the parser's own serialization of code the
 * checks above accept, so what the page can run is exactly what its CSP was built from.
 * Anything else renders as nothing.
 */
export function checkedEmbed(code: string | undefined): string {
  if (!code) return "";
  const provider = embedProvider(code);
  return "html" in provider ? provider.html : "";
}
