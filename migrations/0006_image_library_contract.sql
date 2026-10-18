-- CONTRACT: a rollback to code from before this migration is unsafe. Old code writes
-- gallery_images.alt_* and home_highlights.image_id, which this migration drops, so after it
-- deploys, roll forward only (docs/deploy-runbook.md), and after a Time Travel restore to before
-- it, apply migrations again before the new code serves (docs/backup-restore.md).
--
-- M6.11, image library (ADR-014 §2, contract step). After the expand step (0005) and the
-- operator re-seed, every image row has its Swedish and English alt, the site reads a gallery
-- photo's alt from the image, and nothing writes a highlight's image. This migration makes
-- that the only shape the database accepts.
--
-- The home_highlights rebuild drops and recreates a table that has a foreign key, so foreign
-- key checks wait until the end of the migration's transaction (spike M6.0: without this the
-- remote migration fails and rolls back completely).
PRAGMA defer_foreign_keys = true;

-- 1. Alt is required. SQLite can't add NOT NULL to an existing column without rebuilding
--    images, which six foreign keys point at, so triggers refuse a row without both alts.
--    The column CHECKs from 0005 already refuse empty or whitespace-only text.
CREATE TRIGGER images_alt_required_on_insert BEFORE INSERT ON images
WHEN NEW.alt_sv IS NULL OR NEW.alt_en IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an image needs alt text in Swedish and English');
END;

CREATE TRIGGER images_alt_required_on_update BEFORE UPDATE OF alt_sv, alt_en ON images
WHEN NEW.alt_sv IS NULL OR NEW.alt_en IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an image needs alt text in Swedish and English');
END;

-- The triggers only see new writes. Touching every row that still lacks an alt fires the update
-- trigger, so one such row aborts the whole migration instead of leaving a site whose stored
-- content no longer validates (reviewer M2). Count them on production before merging.
UPDATE images SET alt_sv = alt_sv, alt_en = alt_en WHERE alt_sv IS NULL OR alt_en IS NULL;

-- 2. A gallery photo's alt lives on the image only. Each column has only its own CHECK, so
--    DROP COLUMN works (verified on remote D1 in spike M6.0).
ALTER TABLE gallery_images DROP COLUMN alt_sv;
ALTER TABLE gallery_images DROP COLUMN alt_en;

-- 3. Highlights lose image_id. The column is in a foreign key, so the table is rebuilt:
--    create, copy, drop, rename, then recreate its three content_version triggers (dropping
--    the table dropped them). Nothing references home_highlights.
CREATE TABLE home_highlights_new (
  site_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (site_id, item_id),
  FOREIGN KEY (site_id, item_id) REFERENCES menu_items (site_id, id) ON DELETE CASCADE
) STRICT;

INSERT INTO home_highlights_new (site_id, item_id, position)
SELECT site_id, item_id, position FROM home_highlights;

DROP TABLE home_highlights;
ALTER TABLE home_highlights_new RENAME TO home_highlights;

CREATE TRIGGER home_highlights_insert_bumps_version AFTER INSERT ON home_highlights BEGIN
  UPDATE sites SET content_version = content_version + 1 WHERE id = NEW.site_id;
END;

CREATE TRIGGER home_highlights_update_bumps_version AFTER UPDATE ON home_highlights BEGIN
  UPDATE sites SET content_version = content_version + 1 WHERE id = NEW.site_id;
END;

CREATE TRIGGER home_highlights_delete_bumps_version AFTER DELETE ON home_highlights BEGIN
  UPDATE sites SET content_version = content_version + 1 WHERE id = OLD.site_id;
END;
