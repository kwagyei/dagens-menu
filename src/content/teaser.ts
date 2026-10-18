/**
 * A short opening of a longer text for the home page (owner feedback B5, C5, 18 Oct: the story
 * was on About, and the owner didn't find it). Whole sentences only, as many as fit in `max`
 * characters, always at least the first; a first sentence longer than `max` is cut at a word
 * and ends with "…". No markup: it renders as text.
 */
export function teaser(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  // A sentence ends at . ! ? (optionally followed by a closing quote) and a space.
  const sentences = clean.match(/[^.!?]+[.!?]+["”’)]*(\s|$)/g) ?? [];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).trim().length > max) break;
    out += sentence;
  }
  if (out.trim()) return out.trim();
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}
