-- 0002_homes — Home (server) and membership.
--
-- A Home is a small group (max 40 members, enforced in app logic). Roles are
-- intentionally just 'admin' / 'member' (design doc: no granular roles). The
-- creator becomes the first admin. Agents are ordinary users, so they join
-- via memberships like anyone else.

CREATE TABLE IF NOT EXISTS homes (
  id         TEXT PRIMARY KEY,            -- ULID
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  home_id    TEXT NOT NULL REFERENCES homes (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (home_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
