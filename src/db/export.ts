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
  /** Dish id → date it was marked sold out; not part of the JSON shape. */
  soldOutOn: Record<string, string>;
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
    // Library order: curated files by path, then uploads by id (the JSON fixtures are sorted the same way).
    q("SELECT id, kind, path, width, height, alt_sv, alt_en FROM images WHERE site_id = ? ORDER BY kind = 'upload', coalesce(path, id)"),
    q("SELECT * FROM menu_categories WHERE site_id = ? ORDER BY position, id"),
    q("SELECT * FROM menu_items WHERE site_id = ? ORDER BY position, id"),
    q("SELECT * FROM home_highlights WHERE site_id = ? ORDER BY position, item_id"),
    q("SELECT * FROM weekly_hours WHERE site_id = ? ORDER BY weekday"),
    q("SELECT * FROM hours_exceptions WHERE site_id = ? ORDER BY date"),
    q("SELECT * FROM page_content WHERE site_id = ?"),
    q("SELECT * FROM gallery_images WHERE site_id = ? ORDER BY position, id"),
  ]);
  const s = settings.results[0];
  const p = pages.results[0];
  if (!sites.results[0] || !s || !p) return null;

  // A curated image is referred to by its path, an upload by its id (ADR-014 §1).
  const refOf = new Map(images.results.map((r) => [str(r.id), r.kind === "static" ? str(r.path) : str(r.id)]));
  const imagePath = (id: unknown) => (id === null || id === undefined ? undefined : refOf.get(str(id)));
  // Until the operator re-seeds after migration 0005, curated rows have no alt of their own;
  // a gallery photo's alt is still on its gallery row, so the live gallery keeps its text.
  const galleryAlt = new Map(gallery.results.map((g) => [str(g.image_id), { sv: str(g.alt_sv), en: str(g.alt_en) }]));

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
      images: gallery.results.map((g) => ({ image: imagePath(g.image_id)! })),
    },
    images: images.results.map((r) =>
      compact({
        ref: refOf.get(str(r.id))!,
        alt: r.alt_sv === null || r.alt_en === null ? galleryAlt.get(str(r.id)) : { sv: str(r.alt_sv), en: str(r.alt_en) },
        width: optional(r.width as number | null),
        height: optional(r.height as number | null),
      }),
    ),
  };
  const soldOutOn = Object.fromEntries(items.results.filter((i) => i.sold_out_on !== null).map((i) => [str(i.id), str(i.sold_out_on)]));
  return { content, version: sites.results[0].content_version as number, soldOutOn };
}
