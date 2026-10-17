/**
 * Content from the JSON files in sites/<site>/, validated through the content schema, so
 * invalid content is reported with its path. Uses node:fs: the seed CLI and tests use it, the
 * Worker never imports it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { siteContentSchema } from "./schema";
import type { ContentSource, LoadContext, LoadedContent } from "./source";

const FILES = {
  settings: "content/settings.json",
  hours: "content/hours.json",
  menu: "content/menu.json",
  pages: "content/pages.json",
  gallery: "content/gallery.json",
  images: "content/images.json",
  theme: "theme.json",
} as const;

export interface JsonContentSourceOptions {
  sitesDir?: string;
  /** Keep the first result. On for builds, where files don't change; off in dev, so edits show. */
  cache?: boolean;
}

export class JsonContentSource implements ContentSource {
  readonly sitesDir: string;
  readonly cache: boolean;
  #cached: LoadedContent | undefined;

  constructor(
    readonly site: string,
    { sitesDir = resolve(process.cwd(), "sites"), cache = true }: JsonContentSourceOptions = {},
  ) {
    this.sitesDir = sitesDir;
    this.cache = cache;
  }

  // The JSON content has nothing time-dependent yet; the D1 source uses ctx.now for sold-out flags.
  async load(_ctx: LoadContext): Promise<LoadedContent> {
    if (this.cache && this.#cached) return this.#cached;
    const loaded = this.#read();
    if (this.cache) this.#cached = loaded;
    return loaded;
  }

  #read(): LoadedContent {
    const hash = createHash("sha256");
    const raw: Record<string, unknown> = {};
    for (const [key, file] of Object.entries(FILES)) {
      const path = resolve(this.sitesDir, this.site, file);
      const text = readFileSync(path, "utf-8");
      hash.update(text);
      try {
        raw[key] = JSON.parse(text);
      } catch (error) {
        throw new Error(`Content file ${path} is not valid JSON: ${(error as Error).message}`);
      }
    }
    const result = siteContentSchema(this.site).safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Content for site "${this.site}" is invalid:\n${issues}`);
    }
    return { content: result.data, version: hash.digest("hex").slice(0, 16), stale: false, soldOutOn: {} };
  }
}
