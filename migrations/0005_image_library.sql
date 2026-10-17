-- M6.3, image library (ADR-014 §2, expand step). Every image gets its own Swedish and English
-- alt text and a row version, so an alt edit has the same optimistic concurrency as every
-- other form. The alts stay nullable here: curated rows written before this release have none
-- until the operator re-seeds both demos; the contract migration then requires them.
ALTER TABLE images ADD COLUMN alt_sv TEXT
  CHECK (alt_sv IS NULL OR length(trim(alt_sv, ' ' || char(9, 10, 13, 160, 8203, 8288, 65279))) > 0);
ALTER TABLE images ADD COLUMN alt_en TEXT
  CHECK (alt_en IS NULL OR length(trim(alt_en, ' ' || char(9, 10, 13, 160, 8203, 8288, 65279))) > 0);
ALTER TABLE images ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0;

-- Highlight photos are gone from the content model: a highlighted dish shows its own photo.
-- The column itself goes in the contract migration (it is in a foreign key, so it needs a rebuild).
UPDATE home_highlights SET image_id = NULL WHERE image_id IS NOT NULL;
