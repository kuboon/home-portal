-- 0006_reactions — stamps (reactions) on messages.
--
-- A reaction is a (message, user, stamp) triple; `stamp` is an emoji or short
-- token. A user may place at most 5 distinct stamps per message (enforced in
-- app code, per the design). The recently-used "stamp library" (LRU) lives in
-- Deno KV, not here.

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  stamp      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, user_id, stamp)
);

CREATE INDEX IF NOT EXISTS reactions_message_idx ON reactions (message_id);
