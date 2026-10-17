import { photoSources } from "../content/images";
import type { LibraryImage } from "../content/schema";

/**
 * The picture a shared link previews (og:image): the library photo's 1200-wide size, or its
 * master if smaller, as an absolute URL (crawlers need one). Null when there is no photo or the
 * library doesn't know its size, so the tags are left out rather than guessed.
 */
export function ogImage(image: LibraryImage | undefined, origin: string) {
  const sources = image ? photoSources(image) : null;
  if (!sources) return null;
  const size = sources.sizes.find((s) => s.width === 1200) ?? sources.sizes[sources.sizes.length - 1];
  return { url: new URL(size.url, origin).href, width: size.width, height: size.height };
}
