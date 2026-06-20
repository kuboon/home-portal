-- 0009_main_channel — messages gain home_id and a nullable thread_id.
--
-- The design's "main channel" (one per home, like #general) is NOT a separate
-- table: a main-channel post is simply a post with NO thread_id. To express
-- that, messages must (a) carry their home_id directly (so thread-less posts
-- are still scoped to a home) and (b) allow thread_id to be NULL.
--
-- SQLite cannot drop a column's NOT NULL in place, so the table is rebuilt.
-- This runs inside the migration runner's transaction, where PRAGMA
-- foreign_keys cannot be toggled — and Turso enforces foreign keys — so a
-- naive `DROP TABLE messages` fails: `reactions` rows reference messages rows.
-- We therefore rebuild children-first: stash `reactions`, drop it, rebuild
-- `messages`, then restore `reactions`. At no point is a row left referencing
-- a table being dropped, so it succeeds whether or not FKs are enforced.

CREATE TABLE messages_new (
  id         TEXT PRIMARY KEY,            -- ULID
  home_id    TEXT NOT NULL REFERENCES homes (id),
  thread_id  TEXT REFERENCES threads (id), -- NULL = main channel
  author_id  TEXT NOT NULL REFERENCES users (id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at  TEXT,
  deleted_at TEXT,
  repost_of  TEXT
);

INSERT INTO messages_new
  (id, home_id, thread_id, author_id, body, created_at, edited_at, deleted_at, repost_of)
SELECT m.id, t.home_id, m.thread_id, m.author_id, m.body, m.created_at,
       m.edited_at, m.deleted_at, m.repost_of
FROM messages m
JOIN threads t ON t.id = m.thread_id;

-- Stash reactions (a plain copy, no constraints), then drop the child before
-- the parent so dropping messages violates no foreign key.
CREATE TABLE reactions_backup AS SELECT * FROM reactions;

DROP TABLE reactions;
DROP TABLE messages;

ALTER TABLE messages_new RENAME TO messages;

-- Recreate reactions exactly as of 0006 + 0008 (emoji column), now referencing
-- the rebuilt messages, and restore its rows.
CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, emoji)
);

INSERT INTO reactions (message_id, user_id, emoji, created_at)
SELECT message_id, user_id, emoji, created_at FROM reactions_backup;

DROP TABLE reactions_backup;

CREATE INDEX IF NOT EXISTS reactions_message_idx ON reactions (message_id);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_home_idx ON messages (home_id);
CREATE INDEX IF NOT EXISTS messages_repost_idx ON messages (repost_of);
