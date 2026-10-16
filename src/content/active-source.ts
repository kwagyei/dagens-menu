/**
 * Chooses the ContentSource for this build. The JSON source is imported lazily so its Node
 * dependencies stay out of any bundle that doesn't use it.
 */
import { siteId } from "./site-id";
import type { ContentSource } from "./source";

let source: Promise<ContentSource> | undefined;

export function activeContentSource(): Promise<ContentSource> {
  source ??= import("./json-source").then(
    ({ JsonContentSource }) => new JsonContentSource(siteId(), { cache: import.meta.env.PROD }),
  );
  return source;
}
