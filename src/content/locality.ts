/**
 * The town from a Swedish street address, for the line above the classic hero's name
 * (identity pass, 19 Oct): "Storgatan 12, 111 51 Stockholm" gives "Stockholm". The town is
 * what follows the postcode, in the last part that has one, so a trailing country ("Sverige")
 * or comma is skipped. Null when no part has a Swedish postcode: better no line than a street.
 */
const POSTCODE_TOWN = /^(?:SE-?\s*)?\d{3}\s?\d{2}\s+(\D+)$/i;

export function localityOf(address: string): string | null {
  const parts = address.split(/[,\n]/).map((p) => p.trim());
  for (const part of parts.reverse()) {
    const town = POSTCODE_TOWN.exec(part)?.[1].trim();
    if (town) return town;
  }
  return null;
}
