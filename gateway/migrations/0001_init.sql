-- Hive gateway D1 schema. Identity + routing metadata ONLY — the gateway is an opaque
-- relay and never stores terminal/API content (that's E2E phone<->daemon, M1).
--
-- Conventions (mirror the daemon-side sqlite-schema.ts):
--   * snake_case columns, TEXT / INTEGER affinity only.
--   * *_at columns are epoch MILLISECONDS (INTEGER), set by the app (Date.now()), not SQLite.
--     No DEFAULT CURRENT_TIMESTAMP — D1/SQLite would give a string, and we want a single
--     numeric clock owned by the worker.
--   * revoked_at IS NULL  => live;  revoked_at IS NOT NULL => revoked at that ms.
--   * NO secrets stored in cleartext: daemon tokens live ONLY as a SHA-256 hash.
--
-- Tests apply this via applyD1Migrations(env.DB, env.TEST_MIGRATIONS) in a setup file;
-- readD1Migrations(<migrations_dir>) in vitest.config.ts reads every file here in order.

-- ----------------------------------------------------------------------------
-- users — one row per OAuth identity. First login == signup (no passwords).
-- A user is uniquely the pair (provider, provider_sub). email is informational only
-- (providers can change it / it can collide across providers) — never a join key.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- app-minted opaque id (uuid)
  provider      TEXT NOT NULL,               -- 'github' | 'google'
  provider_sub  TEXT NOT NULL,               -- provider's stable subject id (gh user id / google 'sub')
  email         TEXT,                         -- last-seen email, nullable, informational
  created_at    INTEGER NOT NULL,            -- epoch ms
  CHECK (provider IN ('github', 'google'))
);

-- The account-identity invariant: a given provider subject maps to exactly one user.
CREATE UNIQUE INDEX idx_users_provider_sub ON users (provider, provider_sub);

-- ----------------------------------------------------------------------------
-- daemons — a local Hive runtime bound to an account. The daemon authenticates to
-- the relay with a long-term daemon token; we store ONLY its hash. The token scopes
-- to exactly one (user_id, daemon id) — this is the anti-IDOR root for routing.
-- ----------------------------------------------------------------------------
CREATE TABLE daemons (
  id                 TEXT PRIMARY KEY,        -- app-minted opaque id; this is the routing key the phone targets
  user_id            TEXT NOT NULL,
  name               TEXT NOT NULL,           -- user-facing label ("work laptop")
  daemon_token_hash  TEXT NOT NULL,           -- SHA-256 hex of the long-term daemon token; UNIQUE for O(1) auth lookup
  created_at         INTEGER NOT NULL,        -- epoch ms
  last_seen          INTEGER,                 -- epoch ms, updated on relay connect/heartbeat; NULL = never connected
  revoked_at         INTEGER,                 -- epoch ms; NOT NULL => token dead, relay must refuse
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_daemons_token_hash ON daemons (daemon_token_hash);
CREATE INDEX idx_daemons_user ON daemons (user_id);

-- ----------------------------------------------------------------------------
-- devices — a paired phone/browser client. Trust root: a device row is created ONLY
-- after desktop approval (M4). device_pubkey is the X25519 public key from M1 pairing.
-- A device belongs to a user; the relay never lets a device reach another user's daemon.
-- ----------------------------------------------------------------------------
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,            -- app-minted opaque id == M1 deviceId (handshake transcript binds it)
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,               -- user-facing label ("Pixel 9")
  device_pubkey  TEXT NOT NULL,               -- base64url(32) X25519 public key (M1 DeviceKeyPair.publicKey)
  created_at     INTEGER NOT NULL,            -- epoch ms (== approval time)
  last_active    INTEGER,                     -- epoch ms; NULL = never connected since pairing
  revoked_at     INTEGER,                     -- epoch ms; NOT NULL => device dead, sessions also revoked
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX idx_devices_user ON devices (user_id);

-- ----------------------------------------------------------------------------
-- sessions — one row per minted browser/phone session JWT (keyed by jti). The JWT itself
-- carries user_id + exp; this table is the authoritative record so we can revoke a jti
-- BEFORE its exp (logout / device revoke / "sign out everywhere"). device_id is set for
-- phone sessions, NULL for the desktop login session that approves pairings.
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  jti         TEXT PRIMARY KEY,               -- JWT id; matches the 'jti' claim
  user_id     TEXT NOT NULL,
  device_id   TEXT,                           -- NULL for browser-login session; set for a paired phone
  created_at  INTEGER NOT NULL,               -- epoch ms
  expires_at  INTEGER NOT NULL,               -- epoch ms; JWT exp mirror (defense in depth, also lets us sweep)
  revoked_at  INTEGER,                         -- epoch ms; NOT NULL => reject even if exp not reached
  FOREIGN KEY (user_id)   REFERENCES users (id)   ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_device ON sessions (device_id);

-- ----------------------------------------------------------------------------
-- revocations — single source of truth the hot path consults: "is this credential dead?"
-- Covers session jtis, daemon token hashes, and device ids under one keyspace, so the
-- relay / JWT verify path does ONE lookup. We DENORMALIZE here on revoke (the columns above
-- are for management/listing; this table is the fast deny-list). kind disambiguates the id space.
-- ----------------------------------------------------------------------------
CREATE TABLE revocations (
  id          TEXT NOT NULL,                  -- jti | daemon_token_hash | device_id (interpreted per kind)
  kind        TEXT NOT NULL,                  -- 'session' | 'daemon' | 'device'
  user_id     TEXT NOT NULL,                  -- owning account (audit + bulk-revoke by user)
  revoked_at  INTEGER NOT NULL,               -- epoch ms
  reason      TEXT,                            -- 'logout' | 'device_revoke' | 'daemon_revoke' | 'expired' | ...
  PRIMARY KEY (kind, id),
  CHECK (kind IN ('session', 'daemon', 'device')),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX idx_revocations_user ON revocations (user_id);

-- ----------------------------------------------------------------------------
-- daemon_codes — short-TTL one-time codes for daemon binding (M2 / security invariant #5).
-- `POST /daemon/code` inserts a pending row (no user yet). The logged-in browser approves it
-- (sets user_id + approved_at). The daemon then exchanges it ONCE for a long-term token
-- (sets consumed_at + the created daemon_id). Expired/unapproved/consumed => no token.
-- We store only a hash of the code, same as daemon tokens.
-- ----------------------------------------------------------------------------
CREATE TABLE daemon_codes (
  code_hash    TEXT PRIMARY KEY,              -- SHA-256 hex of the one-time code shown to the daemon
  created_at   INTEGER NOT NULL,             -- epoch ms
  expires_at   INTEGER NOT NULL,             -- epoch ms; past this the code is dead regardless of state
  user_id      TEXT,                          -- NULL until a logged-in browser approves
  approved_at  INTEGER,                       -- epoch ms; NULL = not yet approved in browser
  consumed_at  INTEGER,                       -- epoch ms; NOT NULL => already exchanged, never reusable
  daemon_id    TEXT,                          -- the daemon row created at exchange time
  FOREIGN KEY (user_id)   REFERENCES users (id)    ON DELETE CASCADE,
  FOREIGN KEY (daemon_id) REFERENCES daemons (id)  ON DELETE SET NULL
);

CREATE INDEX idx_daemon_codes_expires ON daemon_codes (expires_at);
