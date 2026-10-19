/**
 * The town from a Swedish street address, for the line above the classic hero's name
 * (identity pass, 19 Oct): "Storgatan 12, 111 51 Stockholm" gives "Stockholm". The last
 * comma-separated part, without its postcode. Null when there's no town to show.
 */
export function localityOf(address: string): string | null {
  const last = address.split(",").pop() ?? "";
  const town = last.replace(/^\s*(SE-?\s*)?\d{3}\s?\d{2}\s*/i, "").trim();
  return town && !/\d/.test(town) ? town : null;
}
