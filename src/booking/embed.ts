/**
 * What a site's third-party embeds may load. The booking embed code is the operator's pasted
 * HTML; it must load from exactly one known provider (src/booking/presets), and the page's CSP
 * then allows that provider's origins and nothing else. The map is an https iframe URL, whose
 * origin the CSP allows as a frame. Nothing loads before consent: the components park both in
 * a <template> until the visitor accepts.
 */
import { type BookingPreset, listPresets } from "./presets";

// The tags embed code may contain. Anything else (style, object, img…) is refused rather than
// guessed at: the CSP is derived from what's checked here.
const ALLOWED_TAGS = new Set(["script", "iframe", "link", "div", "span", "p", "a", "br", "noscript"]);
// Tags whose URL the browser fetches; their origin must be the provider's.
const FETCHING = new Set(["script", "iframe", "link"]);
const TAG = /<\s*([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const URL_ATTR = /\b(src|href|data|srcset|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export type EmbedProvider = { id: string; preset: BookingPreset } | { problem: string };

const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The one provider the embed code loads from, or why it can't be used. */
export function embedProvider(code: string): EmbedProvider {
  // A script runs only from its src: inline code would run under the page's 'unsafe-inline'.
  for (const [, body] of code.matchAll(/<\s*script\b[^>]*>([\s\S]*?)<\s*\/\s*script\s*>/gi)) {
    if (body.trim()) return { problem: "may not contain inline script, only <script src>" };
  }
  if (/\son[a-z]+\s*=/i.test(code) || /javascript:/i.test(code)) return { problem: "may not contain event handlers or javascript: URLs" };

  const origins = new Set<string>();
  for (const [, rawTag, attrs] of code.matchAll(TAG)) {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return { problem: `may not contain <${tag}>` };
    for (const match of attrs.matchAll(URL_ATTR)) {
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      const origin = originOf(value);
      if (!origin) return { problem: `must use https:// URLs, got "${value}"` };
      if (FETCHING.has(tag)) origins.add(origin);
    }
  }
  if (origins.size === 0) return { problem: "must load a booking provider's <script src> or <iframe src>" };

  for (const [id, preset] of Object.entries(listPresets())) {
    if (preset.mode === "embed" && [...origins].every((o) => preset.origins.includes(o))) return { id, preset };
  }
  return { problem: `must load from one known booking provider (src/booking/presets), got ${[...origins].join(", ")}` };
}

/** The third-party origins a site's public pages may use once the visitor consents. */
export interface ThirdPartyOrigins {
  /** The booking provider's origins: scripts, frames, styles, images and requests. */
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
 * The embed code to place in the page, unescaped: only code the checks above accept, so what
 * the page can run is what its CSP was built from. Anything else renders as nothing.
 */
export function checkedEmbed(code: string | undefined): string {
  return code && "preset" in embedProvider(code) ? code : "";
}
