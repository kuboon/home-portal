-- 0001_init — foundation schema.
--
-- Only `users` is needed for the foundation milestone: a signed-in identity
-- (resolved from the id.kbn.one IdP) is recorded here so later features can
-- reference it as a foreign key. Agents are first-class users (design doc),
-- hence `is_agent`.
--
-- The chat domain (homes, members, threads, messages, reposts, …) lands in
-- later migrations as those features are built.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,         -- IdP user id
  display_name TEXT NOT NULL,
  is_agent     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
