/**
 * The site this build (or, later, this Worker) serves. One place, so ADR-011 M3 can switch
 * it to the Worker's SITE_ID binding. There is deliberately no default: a missing value must
 * fail loudly, never serve another restaurant's content.
 */
export function siteId(): string {
  const id = process.env.SITE;
  if (!id) throw new Error("SITE is not set. Run e.g. `SITE=bistro npm run build` (or npm run build:bistro).");
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`SITE "${id}" is not a valid site id.`);
  return id;
}
