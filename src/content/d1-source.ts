/**
 * Content from D1, for the Worker (ADR-011 §2, §3).
 *
 * Each request reads one row, the site's content_version. Only when it differs from the
 * version this isolate already holds is the whole site exported and validated again, so an
 * owner's save is visible on the very next request while most requests cost one tiny query.
 *
 * If D1 fails, the last good copy is served and marked stale; with no copy at all, the error
 * propagates and the caller shows the emergency page. Content that fails the schema (which
 * the database's own checks should make impossible) is treated like an outage, never shown.
 */
import { exportSite } from "../db/export";
import type { D1Database } from "../db/types";
import { siteContentSchema, type Theme } from "./schema";
import type { ContentSource, LoadContext, LoadedContent } from "./source";

export class ContentUnavailableError extends Error {}

export class D1ContentSource implements ContentSource {
  #held: LoadedContent | undefined;

  constructor(
    private readonly db: D1Database,
    readonly site: string,
    private readonly theme: Theme,
  ) {}

  async load(_ctx: LoadContext): Promise<LoadedContent> {
    try {
      const version = await this.db.prepare("SELECT content_version FROM sites WHERE id = ?").bind(this.site).first<number>("content_version");
      if (version === null) throw new ContentUnavailableError(`Site "${this.site}" has no content in D1.`);
      if (this.#held?.version === String(version)) return this.#held;
      this.#held = await this.#read();
      return this.#held;
    } catch (error) {
      if (this.#held) {
        console.error(`content: serving a stale copy of "${this.site}" (version ${this.#held.version}):`, error);
        return { ...this.#held, stale: true };
      }
      throw error instanceof ContentUnavailableError ? error : new ContentUnavailableError(String(error));
    }
  }

  async #read(): Promise<LoadedContent> {
    const exported = await exportSite(this.db, this.site);
    if (!exported) throw new ContentUnavailableError(`Site "${this.site}" has no content in D1.`);
    const result = siteContentSchema(this.site).safeParse({ ...exported.content, theme: this.theme });
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ContentUnavailableError(`Content for "${this.site}" in D1 fails the schema: ${issues}`);
    }
    return { content: result.data, version: String(exported.version), stale: false, soldOutOn: exported.soldOutOn };
  }
}
