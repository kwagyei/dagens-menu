/**
 * Resolves the active site ID from the SITE environment variable.
 * Defaults to "bistro" if not set.
 */
const VALID_SITES = ["bistro", "westafrican"] as const;
type SiteId = (typeof VALID_SITES)[number];

function getSiteId(): SiteId {
  const raw = import.meta.env.SITE_ID ?? "bistro";
  if (!VALID_SITES.includes(raw as SiteId)) {
    throw new Error(
      `Invalid SITE "${raw}". Must be one of: ${VALID_SITES.join(", ")}`,
    );
  }
  return raw as SiteId;
}

export const siteId = getSiteId();
