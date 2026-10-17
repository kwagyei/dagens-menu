/**
 * Turn a site's validated content (the JSON shape) into the statements that store it in D1.
 * Used by the seed CLI (scripts/seed.ts) and the round-trip tests; export.ts is its inverse.
 *
 * The theme is not stored: it stays a developer-edited file (ADR-011 §5).
 */
import { imageReferences, isUploadRef, type SiteContent } from "../content/schema";
import { WEEKDAYS } from "../content/vocabulary";
import { newId } from "./ids";
import { type Statement, stmt } from "./sql";

/** Everything in a site's content except the theme. */
export type StoredContent = Omit<SiteContent, "theme">;

export interface StaticImage {
  /** SHA-256 of the file's bytes, hex. */
  id: string;
  mime: "image/jpeg" | "image/webp";
  /** Pixel size, read from the file by the CLI (sharp); a test resolver may leave it out. */
  width?: number;
  height?: number;
}

/** Looks up a curated image by its path; the CLI hashes the real file, tests fake it. */
export type ImageResolver = (path: string) => StaticImage;

/** Tables holding a site's content, children before parents. Accounts are not touched. */
const CONTENT_TABLES = [
  "gallery_images",
  "home_highlights",
  "menu_items",
  "menu_categories",
  "page_content",
  "settings",
  "weekly_hours",
  "hours_exceptions",
  "image_variants",
  "images",
] as const;

/** Statements that remove a site's content but keep the site, its owners and its audit log. */
export function resetStatements(site: string): Statement[] {
  return CONTENT_TABLES.map((table) => stmt(`DELETE FROM ${table} WHERE site_id = ?`, site));
}

/** Every image reference the content shows, once each, in first-use order. */
export function imageRefsOf(content: StoredContent): string[] {
  return [...new Set(imageReferences(content).map((r) => r.ref))];
}

/**
 * Statements that store `content` for `site`. Assumes the site has no content (run
 * resetStatements first to replace it). The content version moves to at least the current
 * Unix time, so it never returns to a number a cache has already seen before a reset.
 */
export function seedStatements(
  site: string,
  content: StoredContent,
  resolveImage: ImageResolver,
  now = new Date(),
  /** The audit entry's summary; a restore names its file. */
  summary = "Content loaded from JSON",
): Statement[] {
  const out: Statement[] = [];
  const version = Math.floor(now.getTime() / 1000);
  out.push(
    stmt(
      `INSERT INTO sites (id, content_version) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET content_version = max(sites.content_version + 1, excluded.content_version)`,
      site,
      version,
    ),
  );

  // The whole library is registered, used or not, so an owner can switch back to a built-in
  // photo (ADR-014 §3). Uploads only come back through a restore with their bytes (M6.4).
  const imageIds = new Map<string, string>();
  const pathOfId = new Map<string, string>();
  for (const entry of content.images) {
    if (isUploadRef(entry.ref)) throw new Error(`${entry.ref} is an upload; JSON content can only list curated files.`);
    const image = resolveImage(entry.ref);
    const other = pathOfId.get(image.id);
    if (other) throw new Error(`${entry.ref} and ${other} are the same file; list one of them.`);
    pathOfId.set(image.id, entry.ref);
    imageIds.set(entry.ref, image.id);
    out.push(
      stmt(
        "INSERT INTO images (site_id, id, kind, path, mime, width, height, alt_sv, alt_en) VALUES (?, ?, 'static', ?, ?, ?, ?, ?, ?)",
        site,
        image.id,
        entry.ref,
        image.mime,
        entry.width ?? image.width ?? null,
        entry.height ?? image.height ?? null,
        entry.alt?.sv ?? null,
        entry.alt?.en ?? null,
      ),
    );
  }
  const imageId = (ref: string | undefined) => (ref === undefined ? null : (imageIds.get(ref) ?? null));
  const altOf = new Map(content.images.map((i) => [i.ref, i.alt]));

  const s = content.settings;
  out.push(
    stmt(
      `INSERT INTO settings (site_id, name_sv, name_en, tagline_sv, tagline_en, cuisine_sv, cuisine_en, address, phone,
         email, social_links, booking_mode, booking_url, booking_embed_code, map_embed_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      site,
      s.name.sv,
      s.name.en,
      s.tagline.sv,
      s.tagline.en,
      s.cuisine.sv,
      s.cuisine.en,
      s.address,
      s.phone,
      s.email,
      JSON.stringify(s.socialLinks),
      s.booking.provider,
      s.booking.bookingUrl ?? null,
      s.booking.embedCode ?? null,
      s.mapEmbed,
    ),
  );

  content.menu.categories.forEach((category, categoryPosition) => {
    const categoryId = newId();
    out.push(
      stmt(
        "INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES (?, ?, ?, ?, ?, ?)",
        site,
        categoryId,
        category.id,
        category.name.sv,
        category.name.en,
        categoryPosition,
      ),
    );
    category.items.forEach((item, position) => {
      out.push(
        stmt(
          `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore,
             tags, allergens, available, image_id, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          site,
          item.id,
          categoryId,
          item.name.sv,
          item.name.en,
          item.description.sv,
          item.description.en,
          item.price,
          JSON.stringify(item.tags),
          JSON.stringify(item.allergens),
          item.available ? 1 : 0,
          imageId(item.image),
          position,
        ),
      );
    });
  });

  content.pages.home.highlights.forEach((itemId, position) => {
    out.push(
      stmt(
        "INSERT INTO home_highlights (site_id, item_id, position, image_id) VALUES (?, ?, ?, NULL)",
        site,
        itemId,
        position,
      ),
    );
  });

  WEEKDAYS.forEach((day, weekday) => {
    const hours = content.hours.weekly[day];
    out.push(
      stmt("INSERT INTO weekly_hours (site_id, weekday, opens, closes) VALUES (?, ?, ?, ?)", site, weekday, hours?.open ?? null, hours?.close ?? null),
    );
  });
  for (const e of content.hours.exceptions) {
    out.push(
      stmt(
        "INSERT INTO hours_exceptions (site_id, date, opens, closes, note_sv, note_en) VALUES (?, ?, ?, ?, ?, ?)",
        site,
        e.date,
        e.hours?.open ?? null,
        e.hours?.close ?? null,
        e.note.sv,
        e.note.en,
      ),
    );
  }

  const { home, menu, about } = content.pages;
  out.push(
    stmt(
      `INSERT INTO page_content (site_id, home_tagline_sv, home_tagline_en, pull_quote_sv, pull_quote_en, about_story_sv,
         about_story_en, about_chef_sv, about_chef_en, hero_image_id, cta_image_id, menu_hero_image_id, story_image_id,
         kitchen_image_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      site,
      home.tagline.sv,
      home.tagline.en,
      home.pullQuote?.sv ?? null,
      home.pullQuote?.en ?? null,
      about.story.sv,
      about.story.en,
      about.chef.sv,
      about.chef.en,
      imageId(home.heroImage),
      imageId(home.ctaImage),
      imageId(menu.heroImage),
      imageId(about.storyImage),
      imageId(about.kitchenImage),
    ),
  );

  // gallery_images still has its own NOT NULL alt until the contract migration: fill it with
  // the image's alt (the schema guarantees a gallery photo has one).
  content.gallery.images.forEach((g, position) => {
    const alt = altOf.get(g.image);
    if (!alt) throw new Error(`gallery photo ${g.image} has no alt text in the image library`);
    out.push(
      stmt(
        "INSERT INTO gallery_images (site_id, id, image_id, alt_sv, alt_en, position) VALUES (?, ?, ?, ?, ?, ?)",
        site,
        newId(),
        imageId(g.image),
        alt.sv,
        alt.en,
        position,
      ),
    );
  });

  out.push(stmt("INSERT INTO audit_log (site_id, entity, action, summary) VALUES (?, 'site', 'seed', ?)", site, summary));
  return out;
}
