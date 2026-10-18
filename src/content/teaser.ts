/**
 * A short opening of a longer text for the home page (owner feedback B5, C5, 18 Oct: the story
 * was on About, and the owner didn't find it). Whole sentences only, as many as fit in `max`
 * characters, always at least the first; a first sentence longer than `max` is cut at a word
 * and ends with "…". No markup: it renders as text.
 *
 * A sentence ends at . ! or ? (and any closing quote) followed by a space and a capital letter.
 * So "2.5 timmar" and "t.ex. fisk" stay inside their sentence, and splitting only ever happens
 * at whitespace, so no text is lost (tester, 18 Oct: the first version could drop the start).
 */
const SENTENCE_END = /(?<=[.!?…]["”’»)]*)\s+(?=["“”'‘«(]?[A-ZÅÄÖÆØÉÜ])/u;

export function teaser(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let out = "";
  for (const sentence of clean.split(SENTENCE_END)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}
