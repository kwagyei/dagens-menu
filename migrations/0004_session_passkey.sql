-- Which passkey started each session (reviewer M7). Removing a passkey must end the sign-ins
-- made with it, or a lost or stolen device stays signed in for up to 30 days after its
-- passkey is gone. The foreign key makes that a database guarantee: deleting a passkey, from
-- Admin → Security or by any other path, deletes its sessions in the same statement.
--
-- Sessions created before this migration have no passkey recorded (NULL). They can't be
-- tied to a device, so removing any passkey ends the owner's other NULL sessions as well
-- (src/auth/passkeys.ts, removePasskey). They all expire within 30 days of the migration.
--
-- Expand only: code that doesn't know the column keeps inserting sessions, with NULL.

ALTER TABLE sessions ADD COLUMN passkey_id TEXT REFERENCES passkeys (id) ON DELETE CASCADE;

CREATE INDEX sessions_passkey ON sessions (passkey_id);
