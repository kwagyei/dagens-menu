/**
 * The owner's "Export my content" file (ADR-011 plan M5.6) and reading it back. One JSON
 * file with the content in the shape the site is seeded from, so the seed CLI can restore
 * it with `--from`.
 *
 * Format 2 (M6.3, ADR-014 §5) carries the image library with its alt text, and gallery entries
 * name a library image. Format 1 files, which owners may still hold, are upgraded on reading.
 * Uploaded photos' bytes join the file's references in M6.4.
 */
import { imageReferences, type LibraryImage, type SiteSettings, siteContentSchema, type Theme } from "../content/schema";
import type { ExportedSite } from "./export";
import type { StoredContent } from "./seed";

export const EXPORT_FORMAT = "dagens-menu-export";
export const EXPORT_FORMAT_VERSION = 2;
/** Versions readExportFile accepts; older ones are upgraded in memory. */
const READABLE_VERSIONS = [1, 2];

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
  | {
      ok: true;
      content: StoredContent;
      exportedAt: string;
      /** The file's booking or map differed and was replaced. */
      operatorFieldsReplaced: boolean;
      /** A format 1 file's per-highlight photos, which the content model no longer has. */
      highlightImagesDropped: number;
    }
  | { ok: false; error: string };

/** What the repository, not the export, decides: the theme, and booking and the map (ADR-011 §8). */
export interface OperatorContent {
  theme: Theme;
  settings: Pick<SiteSettings, "booking" | "mapEmbed">;
  /** The repository's curated library: a format 1 file's images take their alt from it. */
  images?: LibraryImage[];
}

type Raw = Record<string, unknown>;

/**
 * Format 1 → 2, in memory: gallery `{ src, alt }` becomes `{ image }` with the alt moved to the
 * library; `highlightImages` is dropped; every other referenced curated file takes its alt
 * from the repository's library. Format 1 files hold no uploads, by construction.
 */
function upgradeFromV1(content: Raw, repository: LibraryImage[]): { content: Raw; highlightImagesDropped: number } {
  const pages = (content.pages ?? {}) as Raw;
  const home = (pages.home ?? {}) as Raw;
  const { highlightImages, ...homeRest } = home;
  const highlightImagesDropped = highlightImages && typeof highlightImages === "object" ? Object.keys(highlightImages).length : 0;
  const gallery = (content.gallery ?? {}) as { images?: unknown };
  const upgraded: Raw = { ...content, pages: { ...pages, home: homeRest } };
  // Only a well-formed list is rewritten; anything else is left for the schema to refuse, so a
  // broken file is never restored as an empty gallery (M6.3 tester F1, F2).
  const galleryAlt = new Map<string, unknown>();
  if (Array.isArray(gallery.images)) {
    upgraded.gallery = {
      ...gallery,
      images: gallery.images.map((g) => {
        if (typeof g !== "object" || g === null || Array.isArray(g)) return g;
        const { src, alt, ...rest } = g as Raw;
        // The first alt wins if a photo is in the gallery twice (F5); a missing alt keeps the
        // repository's (F6). Unknown keys stay, so the strict schema refuses them (F3).
        if (typeof src === "string" && alt !== undefined && !galleryAlt.has(src)) galleryAlt.set(src, alt);
        return { ...rest, image: src };
      }),
    };
  }
  // The library: the repository's entries, with this file's gallery alts, plus any referenced
  // file the repository no longer lists (kept without alt; the schema decides if that's valid).
  const library = new Map<string, Raw>(repository.map((i) => [i.ref, { ...i }]));
  for (const [ref, alt] of galleryAlt) library.set(ref, { ...(library.get(ref) ?? { ref }), alt });
  try {
    for (const { ref } of imageReferences(upgraded as never)) if (!library.has(ref)) library.set(ref, { ref });
  } catch {
    // A malformed file: the schema reports it below.
  }
  // Byte order, as SQLite sorts the library on export.
  upgraded.images = [...library.values()].sort((a, b) => (String(a.ref) < String(b.ref) ? -1 : String(a.ref) > String(b.ref) ? 1 : 0));
  return { content: upgraded, highlightImagesDropped };
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
  if (!READABLE_VERSIONS.includes(file.formatVersion as number)) {
    return { ok: false, error: `format version ${quoted(file.formatVersion)} is not supported (expected ${READABLE_VERSIONS.join(" or ")})` };
  }
  if (file.site !== site) return { ok: false, error: `the file is for site ${quoted(file.site)}, not "${site}"` };
  if (typeof file.content !== "object" || file.content === null) return { ok: false, error: "the file has no content" };

  let highlightImagesDropped = 0;
  let fileContent = file.content as Raw;
  if (file.formatVersion === 1) {
    if ("images" in fileContent) return { ok: false, error: "a format 1 file has no image library, but this one has an images list" };
    ({ content: fileContent, highlightImagesDropped } = upgradeFromV1(fileContent, operator.images ?? []));
  }
  const fromFile = fileContent as { settings?: Record<string, unknown> };
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
  return { ok: true, content: content as StoredContent, exportedAt, operatorFieldsReplaced, highlightImagesDropped };
}
