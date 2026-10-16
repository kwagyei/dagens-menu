/**
 * Where a site's content comes from. Pages and components never read content directly:
 * src/middleware.ts loads it through a ContentSource into Astro.locals.content, once per
 * request (once per page at build time). Today the source is the JSON files in
 * sites/<site>/; ADR-011 adds a D1-backed source behind the same interface.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { siteContentSchema, type SiteContent } from "./schema";

export interface ContentSource {
  load(): Promise<SiteContent>;
}

/** Reads sites/<site>/ and validates it, so invalid content fails the build with its path. */
export class JsonContentSource implements ContentSource {
  #cached: SiteContent | undefined;

  constructor(
    readonly site: string,
    readonly sitesDir: string = resolve(process.cwd(), "sites"),
  ) {}

  async load(): Promise<SiteContent> {
    // Files don't change during a build, so one parse serves every page.
    this.#cached ??= this.#read();
    return this.#cached;
  }

  #read(): SiteContent {
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(resolve(this.sitesDir, this.site, file), "utf-8"));
    const result = siteContentSchema(this.site).safeParse({
      settings: read("content/settings.json"),
      hours: read("content/hours.json"),
      menu: read("content/menu.json"),
      pages: read("content/pages.json"),
      gallery: read("content/gallery.json"),
      theme: read("theme.json"),
    });
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Content for site "${this.site}" is invalid:\n${issues}`);
    }
    return result.data;
  }
}
