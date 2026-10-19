-- ADR-018, undo for a deleted dish (expand step). A history entry may carry a JSON snapshot of
-- what it deleted, written in the same batch as the delete, so the owner can put the dish back
-- from the history page or the menu page's flash. Only a `menu_item` `delete` gets one; every
-- other row keeps NULL, and the 180-day purge removes the snapshot with its row.
--
-- Not a contract migration: current code names its audit columns explicitly and never reads
-- payload, so a Worker rollback past this is safe. After a Time Travel restore to before it,
-- apply migrations again before the new code serves (docs/backup-restore.md).
--
-- 16 KiB is five times a dish's largest possible snapshot (TEXT_LIMITS: 80 + 300 characters per
-- language, plus tags and allergens), so a future snapshot of a category with its dishes still
-- needs its own look, not a silent fit.
ALTER TABLE audit_log ADD COLUMN payload TEXT
  CHECK (payload IS NULL OR (json_valid(payload) AND json_type(payload) = 'object' AND length(payload) <= 16384));

-- "Is this entry still undoable?" asks, for one site and one dish, whether any later audit row
-- exists. The history page asks it for each of its 50 entries, so the lookup is indexed.
CREATE INDEX audit_log_entity ON audit_log (site_id, entity, entity_id, id);
