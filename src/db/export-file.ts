/**
 * The owner's "Export my content" file (ADR-011 plan M5.6) and reading it back. One JSON
 * file with the content in the shape the site is seeded from, so the seed CLI can restore
 * it with `--from`. Images are referenced by path; uploaded image files are not in it (M6).
 */
import { siteContentSchema, type Theme } from "../content/schema";
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

export type ReadExportResult = { ok: true; content: StoredContent; exportedAt: string } | { ok: false; error: string };

/**
 * Read an export back for `site`, validated with the same schema as every other content
 * source. `theme` is the site's theme from the repository: it is not part of the export.
 * A file from another site is refused, so a restore can't land in the wrong restaurant.
 */
export function readExportFile(text: string, site: string, theme: Theme): ReadExportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not an export file" };
  const file = raw as Partial<Record<keyof ExportFile, unknown>>;
  if (file.format !== EXPORT_FORMAT) return { ok: false, error: `not a ${EXPORT_FORMAT} file` };
  if (file.formatVersion !== EXPORT_FORMAT_VERSION) return { ok: false, error: `format version ${String(file.formatVersion)} is not supported (expected ${EXPORT_FORMAT_VERSION})` };
  if (file.site !== site) return { ok: false, error: `the file is for site "${String(file.site)}", not "${site}"` };
  if (typeof file.content !== "object" || file.content === null) return { ok: false, error: "the file has no content" };

  const checked = siteContentSchema(site).safeParse({ ...(file.content as object), theme });
  if (!checked.success) {
    const issues = checked.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, error: `the content is not valid:\n  ${issues.join("\n  ")}` };
  }
  const { theme: _theme, ...content } = checked.data;
  return { ok: true, content: content as StoredContent, exportedAt: typeof file.exportedAt === "string" ? file.exportedAt : "unknown" };
}
