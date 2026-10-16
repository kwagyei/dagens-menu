-- Passkey challenges that have been redeemed (ADR-011 §6). A challenge travels in a signed
-- cookie and is otherwise stateless, so without this a captured sign-in could be replayed
-- with its cookie until the cookie expires; synced passkeys (iCloud, Google) report a sign
-- counter of 0, so the counter check can't catch it. Redeeming a challenge inserts it here
-- in the same batch that signs in: a second use fails the primary key and signs nothing in.
-- Rows are kept only until the cookie would have expired anyway.

CREATE TABLE used_challenges (
  challenge TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) IS expires_at)
) STRICT;

CREATE INDEX used_challenges_expires ON used_challenges (expires_at);
