/**
 * The site this Worker serves. The build bakes in one site's theme and curated images, and
 * the Worker's SITE_ID binding selects that site's content in D1; if the two disagree, one
 * restaurant would be shown in another's design. There is deliberately no default.
 */
export class SiteIdError extends Error {}

export function checkSiteId(runtimeId: string | undefined, buildId: string): string {
  if (!runtimeId) throw new SiteIdError(`SITE_ID is not set; this Worker was built for "${buildId}".`);
  if (runtimeId !== buildId) {
    throw new SiteIdError(`SITE_ID "${runtimeId}" does not match the site this Worker was built for ("${buildId}").`);
  }
  return runtimeId;
}
