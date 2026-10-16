-- Admin accounts and sessions (ADR-011 §6). Secrets are never stored: tokens are kept only as
-- SHA-256 hex, and passkeys store only public keys. Every row that grants access is pinned
-- to one site; the admin per site never accepts another site's session or passkey.

CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z0-9]*'),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email GLOB '?*@?*.?*'),
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, site_id)
) STRICT;

-- A passkey is bound to one site's hostname (its WebAuthn RP ID), so it is stored per site.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,  -- the credential id, base64url
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports)),
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_used_at TEXT,
  FOREIGN KEY (user_id, site_id) REFERENCES memberships (user_id, site_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > created_at),
  FOREIGN KEY (user_id, site_id) REFERENCES memberships (user_id, site_id) ON DELETE CASCADE
) STRICT;

-- Single-use enrolment links from the operator CLI; there is no self-signup.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  CHECK (expires_at > created_at),
  FOREIGN KEY (user_id, site_id) REFERENCES memberships (user_id, site_id) ON DELETE CASCADE
) STRICT;

-- Fallback rate limiting when the Workers binding isn't used; key is HMAC(IP), not the IP.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
) STRICT;

CREATE INDEX sessions_user ON sessions (user_id, site_id);
CREATE INDEX passkeys_user ON passkeys (user_id, site_id);
