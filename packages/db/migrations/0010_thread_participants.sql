-- 0010_thread_participants — thread participation + post model (kind/moderation).
--
-- Threads gain an explicit participant set and a last_post_at; posts gain the
-- design's Post fields (kind/ref_post_id, and the hidden vs tombstone split for
-- moderation vs author deletion). This migration is additive (ADD COLUMN +
-- new table), so no table rebuild / foreign-key dance is needed. The legacy
-- `repost_of` and `deleted_at` columns are backfilled into the new columns and
-- left in place for now (removed in a later cleanup).

-- threads: track last activity explicitly (used for auto-archive) instead of
-- recomputing it from messages every listing.
ALTER TABLE threads ADD COLUMN last_post_at TEXT;
UPDATE threads
SET last_post_at = COALESCE(
  (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = threads.id),
  created_at
);

-- The participant set is the source of truth for "who is in this thread":
-- the joined set is the notification audience and the sidebar's joined group.
-- The main channel (thread_id IS NULL) is everyone, so it has no rows here.
CREATE TABLE thread_participants (
  thread_id  TEXT NOT NULL REFERENCES threads (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  state      TEXT NOT NULL DEFAULT 'joined', -- 'joined' | 'left'
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS thread_participants_user_idx
  ON thread_participants (user_id, state);

-- posts (messages): the design's Post fields.
--   kind         'normal' | 'repost' | 'edit'  (edit = forward marker)
--   ref_post_id  the flattened original (repost) or newer version (edit)
--   hidden_at    admin moderation: body retained, visible to admins only
--   tombstone_at author deletion: body destroyed, only the trace remains
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE messages ADD COLUMN ref_post_id TEXT;
ALTER TABLE messages ADD COLUMN hidden_at TEXT;
ALTER TABLE messages ADD COLUMN tombstone_at TEXT;

UPDATE messages SET kind = 'repost', ref_post_id = repost_of
WHERE repost_of IS NOT NULL;

-- Existing soft-deletes were author deletions (body already cleared).
UPDATE messages SET tombstone_at = deleted_at WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_ref_idx ON messages (ref_post_id);
