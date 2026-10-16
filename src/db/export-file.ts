/**
 * The owner's "Export my content" file (ADR-011 plan M5.6) and reading it back. One JSON
 * file with the content in the shape the site is seeded from, so the seed CLI can restore
 * it with `--from`. Images are referenced by path; uploaded image files are not in it (M6).
 */
import { type SiteSettings, siteContentSchema, type Theme } from "../content/schema";
import type { ExportedSite } from "./export";
import type { StoredContent } from "./seed";

export const EXPORT_FORMAT = "dagens-menu-export";
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  site: string;
  /** ISO-8601 UTC, to the second. */
  exportedAt: string;
  contentVersion: number;
  content: StoredContent;
}

export function exportFile(site: string, exported: ExportedSite, now: Date): ExportFile {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    site,
    exportedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    contentVersion: exported.version,
    content: exported.content,
  };
}

/** "bistro-content-2026-10-16.json": the site and the day, so several exports sort by date. */
export const exportFileName = (site: string, now: Date) => `${site}-content-${now.toISOString().slice(0, 10)}.json`;

const quoted = (value: unknown) => (JSON.stringify(value) ?? "undefined").slice(0, 80);

export type ReadExportResult =
  | { ok: true; content: StoredContent; exportedAt: string; /** The file's booking or map differed and was replaced. */ operatorFieldsReplaced: boolean }
  | { ok: false; error: string };

/** What the repository, not the export, decides: the theme, and booking and the map (ADR-011 §8). */
export interface OperatorContent {
  theme: Theme;
  settings: Pick<SiteSettings, "booking" | "mapEmbed">;
}

/**
 * Read an export back for `site`, validated with the same schema as every other content
 * source. The theme, booking and the map come from the repository (`operator`), whatever
 * the file says: an owner's file, however edited, can't set an embed or a map URL. A file
 * from another site is refused, so a restore can't land in the wrong restaurant.
 */
export function readExportFile(text: string, site: string, operator: OperatorContent): ReadExportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, "")); // editors on Windows may add a BOM
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not an export file" };
  const file = raw as Partial<Record<keyof ExportFile, unknown>>;
  if (file.format !== EXPORT_FORMAT) return { ok: false, error: `not a ${EXPORT_FORMAT} file` };
  // Values from the file are shown JSON-quoted: a crafted file can't put escape codes on
  // the operator's terminal.
  if (file.formatVersion !== EXPORT_FORMAT_VERSION) return { ok: false, error: `format version ${quoted(file.formatVersion)} is not supported (expected ${EXPORT_FORMAT_VERSION})` };
  if (file.site !== site) return { ok: false, error: `the file is for site ${quoted(file.site)}, not "${site}"` };
  if (typeof file.content !== "object" || file.content === null) return { ok: false, error: "the file has no content" };

  const fromFile = file.content as { settings?: Record<string, unknown> };
  const operatorFieldsReplaced =
    JSON.stringify({ booking: fromFile.settings?.booking, mapEmbed: fromFile.settings?.mapEmbed }) !==
    JSON.stringify({ booking: operator.settings.booking, mapEmbed: operator.settings.mapEmbed });
  const merged = { ...fromFile, settings: { ...fromFile.settings, booking: operator.settings.booking, mapEmbed: operator.settings.mapEmbed }, theme: operator.theme };
  const checked = siteContentSchema(site).safeParse(merged);
  if (!checked.success) {
    const issues = checked.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, error: `the content is not valid:\n  ${issues.join("\n  ")}` };
  }
  const { theme: _theme, ...content } = checked.data;
  const exportedAt = typeof file.exportedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(file.exportedAt) ? file.exportedAt : "unknown";
  return { ok: true, content: content as StoredContent, exportedAt, operatorFieldsReplaced };
}
