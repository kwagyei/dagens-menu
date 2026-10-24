/**
 * What the photo library pages show about a photo (plan M6.10): a small preview and where the
 * photo is used, in the page's language, with a link to each place where the owner can change
 * it. Pure, so it is unit-tested without a database.
 */
import { photoSources } from "../content/images";
import type { ImageUse, LibraryImage } from "../db/library";
import { fill, localePath, t, type TranslationKey } from "../i18n";

type Locale = "sv" | "en";

/** The smallest stored size, for a 96 px preview; null if the library doesn't know the size. */
export function thumbnail(image: Pick<LibraryImage, "ref" | "width" | "height">): { src: string; width: number; height: number } | null {
  if (!image.width || !image.height) return null;
  const sources = photoSources({ ref: image.ref, width: image.width, height: image.height });
  const smallest = sources?.sizes[0];
  return smallest ? { src: smallest.url, width: smallest.width, height: smallest.height } : null;
}

/** Where the gallery is put together (M6.10b). */
const GALLERY_PAGE = "/admin/gallery/";

/** Each use as words and the admin page where it can be changed. */
export function describeUses(uses: readonly ImageUse[], locale: Locale): Array<{ label: string; href: string }> {
  return uses.map((use) => {
    if (use.kind === "dish") return { label: fill(t(locale, "admin.photos.useDish"), { name: use.name[locale] }), href: localePath(locale, `/admin/menu/item/${use.id}/photo/`) };
    if (use.kind === "gallery") return { label: t(locale, "admin.photos.useGallery").replace("{n}", String(use.position)), href: localePath(locale, GALLERY_PAGE) };
    return { label: t(locale, `admin.photos.slot.${use.slot}` as TranslationKey), href: localePath(locale, `/admin/page-photos/${use.slot}/`) };
  });
}
