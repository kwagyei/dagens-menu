/**
 * The restaurant's texts for the admin (ADR-011 plan M5.5): its settings (name, tagline,
 * cuisine, contact, social links) and the page texts (home tagline, pull quote, about).
 * Booking and map settings are operator-only (§8): nothing here reads or writes them.
 * Same rules as every content write: scoped to the context's site, validated with the
 * content schema, guarded on row_version, one batch with its audit entry.
 */
import { ownerSettingsSchema, pageTextsSchema } from "../content/schema";
import { commitIf, isoSeconds, type RepoContext, type WriteResult } from "./repository";
import { stmt } from "./sql";

type Localized = { sv: string; en: string };

export interface OwnerSettings {
  name: Localized;
  tagline: Localized;
  cuisine: Localized;
  address: string;
  phone: string;
  email: string;
  socialLinks: Record<string, string>;
}

export interface PageTexts {
  homeTagline: Localized;
  /** Optional, but never in only one language. */
  pullQuote: Localized | null;
  aboutStory: Localized;
  aboutChef: Localized;
}

export interface AdminTexts {
  settings: OwnerSettings & { rowVersion: number };
  pages: PageTexts & { rowVersion: number };
}

type Row = Record<string, unknown>;
const pair = (r: Row, column: string): Localized => ({ sv: r[`${column}_sv`] as string, en: r[`${column}_en`] as string });
const issuesOf = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) => error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

export async function adminTexts(ctx: RepoContext): Promise<AdminTexts | null> {
  const [settings, pages] = await ctx.db.batch<Row>([
    ctx.db
      .prepare("SELECT name_sv, name_en, tagline_sv, tagline_en, cuisine_sv, cuisine_en, address, phone, email, social_links, row_version FROM settings WHERE site_id = ?")
      .bind(ctx.siteId),
    ctx.db
      .prepare(
        "SELECT home_tagline_sv, home_tagline_en, pull_quote_sv, pull_quote_en, about_story_sv, about_story_en, about_chef_sv, about_chef_en, row_version FROM page_content WHERE site_id = ?",
      )
      .bind(ctx.siteId),
  ]);
  const s = settings.results[0];
  const p = pages.results[0];
  if (!s || !p) return null;
  return {
    settings: {
      name: pair(s, "name"),
      tagline: pair(s, "tagline"),
      cuisine: pair(s, "cuisine"),
      address: s.address as string,
      phone: s.phone as string,
      email: s.email as string,
      socialLinks: JSON.parse(s.social_links as string),
      rowVersion: s.row_version as number,
    },
    pages: {
      homeTagline: pair(p, "home_tagline"),
      pullQuote: p.pull_quote_sv === null ? null : pair(p, "pull_quote"),
      aboutStory: pair(p, "about_story"),
      aboutChef: pair(p, "about_chef"),
      rowVersion: p.row_version as number,
    },
  };
}

/** The names of the fields that differ, for the audit summary. */
function changedFields<T extends object>(before: T, after: T): string[] {
  return (Object.keys(after) as Array<keyof T>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(String);
}

const summary = (what: string, changed: string[]) => `${what}: ${changed.length > 0 ? changed.join(", ") : "saved without changes"}`;

/** Edit the owner's settings. A stale form (someone saved in between) is a conflict. */
export async function updateSettings(ctx: RepoContext, expectedRowVersion: number, edit: OwnerSettings): Promise<WriteResult> {
  const checked = ownerSettingsSchema.safeParse(edit);
  if (!checked.success) return { ok: false, error: "invalid", issues: issuesOf(checked.error) };
  const before = await adminTexts(ctx);
  if (!before) return { ok: false, error: "not-found" };
  const v = checked.data;
  const { rowVersion: _, ...beforeSettings } = before.settings;
  const changed = await commitIf(
    ctx,
    stmt(
      `UPDATE settings SET name_sv = ?, name_en = ?, tagline_sv = ?, tagline_en = ?, cuisine_sv = ?, cuisine_en = ?, address = ?,
         phone = ?, email = ?, social_links = ?, row_version = row_version + 1, updated_at = ?, updated_by = ?
       WHERE site_id = ? AND row_version = ?`,
      v.name.sv,
      v.name.en,
      v.tagline.sv,
      v.tagline.en,
      v.cuisine.sv,
      v.cuisine.en,
      v.address,
      v.phone,
      v.email,
      JSON.stringify(v.socialLinks),
      isoSeconds(ctx.now),
      ctx.userId,
      ctx.siteId,
      expectedRowVersion,
    ),
    { entity: "settings", entityId: null, action: "update", summary: summary("settings", changedFields(beforeSettings, v)) },
  );
  if (changed) return { ok: true };
  const current = await adminTexts(ctx);
  return current ? { ok: false, error: "conflict", current: current.settings.rowVersion } : { ok: false, error: "not-found" };
}

/** Edit the page texts. A stale form is a conflict. Images are left as they are (M6). */
export async function updatePageTexts(ctx: RepoContext, expectedRowVersion: number, edit: PageTexts): Promise<WriteResult> {
  const checked = pageTextsSchema.safeParse(edit);
  if (!checked.success) return { ok: false, error: "invalid", issues: issuesOf(checked.error) };
  const before = await adminTexts(ctx);
  if (!before) return { ok: false, error: "not-found" };
  const v = checked.data;
  const { rowVersion: _, ...beforePages } = before.pages;
  const changed = await commitIf(
    ctx,
    stmt(
      `UPDATE page_content SET home_tagline_sv = ?, home_tagline_en = ?, pull_quote_sv = ?, pull_quote_en = ?, about_story_sv = ?,
         about_story_en = ?, about_chef_sv = ?, about_chef_en = ?, row_version = row_version + 1, updated_at = ?, updated_by = ?
       WHERE site_id = ? AND row_version = ?`,
      v.homeTagline.sv,
      v.homeTagline.en,
      v.pullQuote?.sv ?? null,
      v.pullQuote?.en ?? null,
      v.aboutStory.sv,
      v.aboutStory.en,
      v.aboutChef.sv,
      v.aboutChef.en,
      isoSeconds(ctx.now),
      ctx.userId,
      ctx.siteId,
      expectedRowVersion,
    ),
    { entity: "page_content", entityId: null, action: "update", summary: summary("page texts", changedFields(beforePages, v)) },
  );
  if (changed) return { ok: true };
  const current = await adminTexts(ctx);
  return current ? { ok: false, error: "conflict", current: current.pages.rowVersion } : { ok: false, error: "not-found" };
}
