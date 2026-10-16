/**
 * Read a site's content out of D1 in the JSON shape the site was seeded from (seed.ts is the
 * inverse). Used by the round-trip tests, by the D1 content source (ADR-011 M3) and by the
 * admin's "Export my content" button.
 */
import { WEEKDAYS } from "../content/vocabulary";
import type { StoredContent } from "./seed";
import type { D1Database } from "./types";

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

/** Drop keys whose value is undefined, so optional fields are absent rather than undefined. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export interface ExportedSite {
  content: StoredContent;
  version: number;
}

/**
 * The site's content and the version it was read at, or null if the site has no content.
 * All reads run in one batch, which D1 executes as a single transaction: a consistent
 * snapshot, never half of an owner's save.
 */
export async function exportSite(db: D1Database, site: string): Promise<ExportedSite | null> {
  const q = (sql: string) => db.prepare(sql).bind(site);
  const [sites, settings, images, categories, items, highlights, weekly, exceptions, pages, gallery] = await db.batch<Row>([
    q("SELECT content_version FROM sites WHERE id = ?"),
    q("SELECT * FROM settings WHERE site_id = ?"),
    q("SELECT id, path FROM images WHERE site_id = ?"),
    q("SELECT * FROM menu_categories WHERE site_id = ? ORDER BY position"),
    q("SELECT * FROM menu_items WHERE site_id = ? ORDER BY position"),
    q("SELECT * FROM home_highlights WHERE site_id = ? ORDER BY position"),
    q("SELECT * FROM weekly_hours WHERE site_id = ? ORDER BY weekday"),
    q("SELECT * FROM hours_exceptions WHERE site_id = ? ORDER BY date"),
    q("SELECT * FROM page_content WHERE site_id = ?"),
    q("SELECT * FROM gallery_images WHERE site_id = ? ORDER BY position"),
  ]);
  const s = settings.results[0];
  const p = pages.results[0];
  if (!sites.results[0] || !s || !p) return null;

  const pathOf = new Map(images.results.map((r) => [str(r.id), str(r.path)]));
  // Uploads have no static path yet; they get a media URL with the upload feature (M6).
  const imagePath = (id: unknown) => (id === null || id === undefined ? undefined : pathOf.get(str(id)));

  const highlightImages = Object.fromEntries(
    highlights.results.flatMap((h) => {
      const path = imagePath(h.image_id);
      return path ? [[str(h.item_id), path]] : [];
    }),
  );

  const content: StoredContent = {
    settings: {
      name: { sv: str(s.name_sv), en: str(s.name_en) },
      tagline: { sv: str(s.tagline_sv), en: str(s.tagline_en) },
      cuisine: { sv: str(s.cuisine_sv), en: str(s.cuisine_en) },
      address: str(s.address),
      phone: str(s.phone),
      email: str(s.email),
      socialLinks: JSON.parse(str(s.social_links)),
      booking: compact({
        provider: s.booking_mode as StoredContent["settings"]["booking"]["provider"],
        embedCode: optional(s.booking_embed_code as string | null),
        bookingUrl: optional(s.booking_url as string | null),
      }),
      mapEmbed: str(s.map_embed_url),
    },
    hours: {
      weekly: Object.fromEntries(
        WEEKDAYS.map((day, weekday) => {
          const row = weekly.results.find((r) => r.weekday === weekday);
          return [day, row && row.opens !== null ? { open: str(row.opens), close: str(row.closes) } : null];
        }),
      ) as StoredContent["hours"]["weekly"],
      exceptions: exceptions.results.map((e) => ({
        date: str(e.date),
        note: { sv: str(e.note_sv), en: str(e.note_en) },
        hours: e.opens === null ? null : { open: str(e.opens), close: str(e.closes) },
      })),
    },
    menu: {
      categories: categories.results.map((c) => ({
        id: str(c.slug),
        name: { sv: str(c.name_sv), en: str(c.name_en) },
        items: items.results
          .filter((i) => i.category_id === c.id)
          .map((i) =>
            compact({
              id: str(i.id),
              name: { sv: str(i.name_sv), en: str(i.name_en) },
              description: { sv: str(i.description_sv), en: str(i.description_en) },
              price: i.price_ore as number,
              tags: JSON.parse(str(i.tags)),
              allergens: JSON.parse(str(i.allergens)),
              available: i.available === 1,
              image: imagePath(i.image_id),
            }),
          ),
      })),
    },
    pages: {
      home: compact({
        tagline: { sv: str(p.home_tagline_sv), en: str(p.home_tagline_en) },
        highlights: highlights.results.map((h) => str(h.item_id)),
        heroImage: imagePath(p.hero_image_id),
        highlightImages: Object.keys(highlightImages).length > 0 ? highlightImages : undefined,
        pullQuote: p.pull_quote_sv === null ? undefined : { sv: str(p.pull_quote_sv), en: str(p.pull_quote_en) },
        ctaImage: imagePath(p.cta_image_id),
      }),
      menu: compact({ heroImage: imagePath(p.menu_hero_image_id) }),
      about: compact({
        story: { sv: str(p.about_story_sv), en: str(p.about_story_en) },
        chef: { sv: str(p.about_chef_sv), en: str(p.about_chef_en) },
        storyImage: imagePath(p.story_image_id),
        kitchenImage: imagePath(p.kitchen_image_id),
      }),
    },
    gallery: {
      images: gallery.results.map((g) => ({
        src: imagePath(g.image_id) ?? "",
        alt: { sv: str(g.alt_sv), en: str(g.alt_en) },
      })),
    },
  };
  return { content, version: sites.results[0].content_version as number };
}
