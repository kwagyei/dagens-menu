const LINE_SEPARATOR = new RegExp("\\u2028", "g");
const PARAGRAPH_SEPARATOR = new RegExp("\\u2029", "g");

/**
 * Serialise structured data for a <script type="application/ld+json"> block. Owners now type
 * dish names and texts, so JSON.stringify alone is not enough: a name containing
 * "</script>" would end the block and let the rest run as HTML. Escaping <, > and & as
 * \u-sequences keeps the JSON identical to a parser and inert to the HTML tokenizer.
 * U+2028 and U+2029 are escaped too, for older JavaScript parsers.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}
