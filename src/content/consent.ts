/**
 * Whether a site loads anything that needs cookie consent (ADR-006). Only an embedded
 * booking widget or a map embed does; a booking link is an ordinary link. A site with
 * neither shows no banner: asking for consent to nothing contradicts the privacy page.
 */
import type { SiteSettings } from "./schema";

export function needsConsent(settings: Pick<SiteSettings, "booking" | "mapEmbed">): boolean {
  const embed = settings.booking.provider === "embed" && Boolean(settings.booking.embedCode?.trim());
  return embed || settings.mapEmbed !== "";
}
