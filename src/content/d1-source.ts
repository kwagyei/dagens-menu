/**
 * Content from D1, for the Worker (ADR-011 §2, §3).
 *
 * Each request reads one row, the site's content_version. Only when it differs from the
 * version this isolate already holds is the whole site exported and validated again, so an
 * owner's save is visible on the very next request while most requests cost one tiny query.
 *
 * If D1 fails or takes longer than READ_TIMEOUT_MS, the last good copy is served and marked
 * stale; with no copy at all, the error propagates and the caller shows the emergency page.
 *
 * Content that fails the schema is never shown. The database checks only part of the schema
 * (vocabularies and length caps are the app's job), so a hand-written query can store such
 * content; the admin's save path can't. A version that failed is remembered, so the site
 * isn't re-read and re-logged on every request until the next save fixes it.
 */
import { exportSite } from "../db/export";
import type { D1Database } from "../db/types";
import { siteContentSchema, type Theme } from "./schema";
import type { ContentSource, LoadContext, LoadedContent } from "./source";

export class ContentUnavailableError extends Error {}

/** ADR-011 §3: past this, serve what we have rather than keep the visitor waiting. */
export const READ_TIMEOUT_MS = 1500;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ContentUnavailableError(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class D1ContentSource implements ContentSource {
  #held: LoadedContent | undefined;
  /** A version whose content failed the schema, and why. */
  #rejected: { version: string; reason: string } | undefined;

  constructor(
    private readonly db: D1Database,
    readonly site: string,
    private readonly theme: Theme,
    private readonly timeoutMs = READ_TIMEOUT_MS,
  ) {}

  async load(_ctx: LoadContext): Promise<LoadedContent> {
    let version: string;
    try {
      const row = await withTimeout(
        this.db.prepare("SELECT content_version FROM sites WHERE id = ?").bind(this.site).first<number>("content_version"),
        this.timeoutMs,
        "Reading the content version",
      );
      if (row === null) throw new ContentUnavailableError(`Site "${this.site}" has no content in D1.`);
      version = String(row);
    } catch (error) {
      return this.#fallBack(error);
    }

    if (this.#held?.version === version) return this.#held;
    if (this.#rejected?.version === version) return this.#fallBack(new ContentUnavailableError(this.#rejected.reason), false);

    try {
      this.#held = await withTimeout(this.#read(version), this.timeoutMs, "Reading the content");
      return this.#held;
    } catch (error) {
      return this.#fallBack(error);
    }
  }

  #fallBack(error: unknown, log = true): LoadedContent {
    if (log) console.error(`content: "${this.site}": ${error instanceof Error ? error.message : String(error)}`);
    if (this.#held) return { ...this.#held, stale: true };
    throw error instanceof ContentUnavailableError ? error : new ContentUnavailableError(String(error));
  }

  async #read(version: string): Promise<LoadedContent> {
    const exported = await exportSite(this.db, this.site);
    if (!exported) throw new ContentUnavailableError(`Site "${this.site}" has no content in D1.`);
    const result = siteContentSchema(this.site).safeParse({ ...exported.content, theme: this.theme });
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      const reason = `Content version ${version} fails the schema, so it isn't shown: ${issues}`;
      // Keyed by the version read before the export: if a save landed in between, the next
      // request sees a new version and tries again.
      this.#rejected = { version, reason };
      throw new ContentUnavailableError(reason);
    }
    return { content: result.data, version: String(exported.version), stale: false, soldOutOn: exported.soldOutOn };
  }
}
