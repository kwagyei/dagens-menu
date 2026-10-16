-- Restaurant content (ADR-011 §5). Every row carries site_id and every query is scoped by it.
-- The CHECK constraints repeat the content schema's core rules (src/content/schema.ts) as a
-- second wall: a bug in the app, or a hand-written query, still can't store invalid content.
-- Conventions: ids are app-generated text; times are HH:MM; dates are YYYY-MM-DD; money is
-- INTEGER öre; bilingual text is paired *_sv / *_en columns, both required.

CREATE TABLE sites (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND id NOT GLOB '*[^a-z0-9-]*' AND length(id) BETWEEN 1 AND 40),
  -- Bumped in the same transaction as every content write; pages and caches key on it.
  content_version INTEGER NOT NULL DEFAULT 0 CHECK (content_version >= 0),
  time_zone TEXT NOT NULL DEFAULT 'Europe/Stockholm',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

-- Images referenced by content. Static ones are curated files deployed with the code
-- (path under /images/<site>/); uploads (ADR-011 §7) keep their bytes in image_variants.
CREATE TABLE images (
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),  -- sha-256 of the bytes
  kind TEXT NOT NULL CHECK (kind IN ('static', 'upload')),
  path TEXT CHECK (path IS NULL OR path GLOB '/images/*'),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 10000),
  height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 10000),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (site_id, id),
  UNIQUE (site_id, path),
  CHECK ((kind = 'static') = (path IS NOT NULL))
) STRICT;

CREATE TABLE image_variants (
  site_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 2000),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),  -- 1 MiB, under D1's 2 MB row limit
  PRIMARY KEY (site_id, image_id, width),
  FOREIGN KEY (site_id, image_id) REFERENCES images (site_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE settings (
  site_id TEXT PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  name_sv TEXT NOT NULL CHECK (length(trim(name_sv)) > 0),
  name_en TEXT NOT NULL CHECK (length(trim(name_en)) > 0),
  tagline_sv TEXT NOT NULL CHECK (length(trim(tagline_sv)) > 0),
  tagline_en TEXT NOT NULL CHECK (length(trim(tagline_en)) > 0),
  cuisine_sv TEXT NOT NULL CHECK (length(trim(cuisine_sv)) > 0),
  cuisine_en TEXT NOT NULL CHECK (length(trim(cuisine_en)) > 0),
  address TEXT NOT NULL CHECK (length(trim(address)) > 0),
  phone TEXT NOT NULL CHECK (length(phone) >= 7),
  email TEXT NOT NULL CHECK (email GLOB '?*@?*.?*'),
  -- {"instagram": "https://..."}; key and URL rules are enforced by the schema.
  social_links TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(social_links) AND json_type(social_links) = 'object'),
  -- Operator-only fields (ADR-011 §8): owners can't edit booking or map settings.
  booking_mode TEXT NOT NULL DEFAULT 'none' CHECK (booking_mode IN ('none', 'embed', 'link')),
  booking_url TEXT CHECK (booking_url IS NULL OR booking_url GLOB 'https://?*'),
  booking_embed_code TEXT CHECK (booking_embed_code IS NULL OR length(booking_embed_code) <= 5000),
  map_embed_url TEXT NOT NULL DEFAULT '' CHECK (map_embed_url = '' OR map_embed_url GLOB 'https://?*'),
  row_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT,
  CHECK (booking_mode <> 'link' OR booking_url IS NOT NULL),
  CHECK (booking_mode <> 'embed' OR length(trim(coalesce(booking_embed_code, ''))) > 0)
) STRICT;

CREATE TABLE menu_categories (
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z0-9]*'),
  -- The URL-safe name the templates and anchors use, e.g. "starters".
  slug TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT GLOB '*--*' AND slug NOT GLOB '*-'),
  name_sv TEXT NOT NULL CHECK (length(trim(name_sv)) > 0),
  name_en TEXT NOT NULL CHECK (length(trim(name_en)) > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  row_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, id),
  UNIQUE (site_id, slug)
) STRICT;

CREATE TABLE menu_items (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z0-9]*'),
  category_id TEXT NOT NULL,
  name_sv TEXT NOT NULL CHECK (length(trim(name_sv)) > 0),
  name_en TEXT NOT NULL CHECK (length(trim(name_en)) > 0),
  description_sv TEXT NOT NULL CHECK (length(trim(description_sv)) > 0),
  description_en TEXT NOT NULL CHECK (length(trim(description_en)) > 0),
  price_ore INTEGER NOT NULL CHECK (price_ore BETWEEN 0 AND 10000000),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  allergens TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allergens) AND json_type(allergens) = 'array'),
  -- Off the menu until the owner turns it back on (the content model's "available").
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  -- Sold out only on this Stockholm date: the one-tap toggle, clearing itself at midnight.
  sold_out_on TEXT CHECK (sold_out_on IS NULL OR sold_out_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  image_id TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  row_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT,
  PRIMARY KEY (site_id, id),
  FOREIGN KEY (site_id, category_id) REFERENCES menu_categories (site_id, id) ON DELETE CASCADE,
  -- Image references use the default NO ACTION, which SQLite checks at the end of each
  -- statement rather than row by row (as RESTRICT would): deleting an image in use still
  -- fails, but deleting a whole site cascades through images and the rows using them.
  -- (Deferred checks crash local D1 on violation; SET NULL would also null site_id.)
  FOREIGN KEY (site_id, image_id) REFERENCES images (site_id, id)
) STRICT;

CREATE TABLE home_highlights (
  site_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  image_id TEXT,
  PRIMARY KEY (site_id, item_id),
  FOREIGN KEY (site_id, item_id) REFERENCES menu_items (site_id, id) ON DELETE CASCADE,
  FOREIGN KEY (site_id, image_id) REFERENCES images (site_id, id)
) STRICT;

-- Exactly seven rows per site; weekday 0 = Monday ... 6 = Sunday. NULL times mean closed.
-- closes < opens is allowed: it means closing after midnight.
CREATE TABLE weekly_hours (
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens TEXT CHECK (opens IS NULL OR (opens GLOB '[0-2][0-9]:[0-5][0-9]' AND opens < '24:00')),
  closes TEXT CHECK (closes IS NULL OR (closes GLOB '[0-2][0-9]:[0-5][0-9]' AND closes < '24:00')),
  PRIMARY KEY (site_id, weekday),
  CHECK ((opens IS NULL) = (closes IS NULL)),
  CHECK (opens IS NULL OR opens <> closes)
) STRICT;

CREATE TABLE hours_exceptions (
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) = date),
  opens TEXT CHECK (opens IS NULL OR (opens GLOB '[0-2][0-9]:[0-5][0-9]' AND opens < '24:00')),
  closes TEXT CHECK (closes IS NULL OR (closes GLOB '[0-2][0-9]:[0-5][0-9]' AND closes < '24:00')),
  note_sv TEXT NOT NULL CHECK (length(trim(note_sv)) > 0),
  note_en TEXT NOT NULL CHECK (length(trim(note_en)) > 0),
  PRIMARY KEY (site_id, date),
  CHECK ((opens IS NULL) = (closes IS NULL)),
  CHECK (opens IS NULL OR opens <> closes)
) STRICT;

-- One typed row per site, not a key-value table.
CREATE TABLE page_content (
  site_id TEXT PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  home_tagline_sv TEXT NOT NULL CHECK (length(trim(home_tagline_sv)) > 0),
  home_tagline_en TEXT NOT NULL CHECK (length(trim(home_tagline_en)) > 0),
  pull_quote_sv TEXT,
  pull_quote_en TEXT,
  about_story_sv TEXT NOT NULL CHECK (length(trim(about_story_sv)) > 0),
  about_story_en TEXT NOT NULL CHECK (length(trim(about_story_en)) > 0),
  about_chef_sv TEXT NOT NULL CHECK (length(trim(about_chef_sv)) > 0),
  about_chef_en TEXT NOT NULL CHECK (length(trim(about_chef_en)) > 0),
  hero_image_id TEXT,
  cta_image_id TEXT,
  menu_hero_image_id TEXT,
  story_image_id TEXT,
  kitchen_image_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT,
  -- A pull quote is optional, but never in only one language.
  CHECK ((pull_quote_sv IS NULL) = (pull_quote_en IS NULL)),
  CHECK (pull_quote_sv IS NULL OR (length(trim(pull_quote_sv)) > 0 AND length(trim(pull_quote_en)) > 0)),
  FOREIGN KEY (site_id, hero_image_id) REFERENCES images (site_id, id),
  FOREIGN KEY (site_id, cta_image_id) REFERENCES images (site_id, id),
  FOREIGN KEY (site_id, menu_hero_image_id) REFERENCES images (site_id, id),
  FOREIGN KEY (site_id, story_image_id) REFERENCES images (site_id, id),
  FOREIGN KEY (site_id, kitchen_image_id) REFERENCES images (site_id, id)
) STRICT;

CREATE TABLE gallery_images (
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z0-9]*'),
  image_id TEXT NOT NULL,
  alt_sv TEXT NOT NULL CHECK (length(trim(alt_sv)) > 0),
  alt_en TEXT NOT NULL CHECK (length(trim(alt_en)) > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (site_id, id),
  FOREIGN KEY (site_id, image_id) REFERENCES images (site_id, id)
) STRICT;

-- Who changed what. Replaces "git blame" for content; kept 180 days.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  user_id TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'seed', 'reorder')),
  summary TEXT NOT NULL
) STRICT;

CREATE INDEX audit_log_site_at ON audit_log (site_id, at);
CREATE INDEX menu_items_category ON menu_items (site_id, category_id, position);
