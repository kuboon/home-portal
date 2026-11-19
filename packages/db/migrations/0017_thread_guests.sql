-- 0017_thread_guests — guests: non-members admitted to a single thread.
--
-- A guest can read and post in one thread of a home they are not a member of
-- (invited by a home admin with a thread invite code). Kept apart from
-- `memberships` so the member cap / role CHECK stay untouched and a guest
-- never sees the rest of the home. Notification audience still comes from
-- `thread_participants` (a guest is joined on admission).
CREATE TABLE thread_guests (
  thread_id  TEXT NOT NULL REFERENCES threads (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  invited_by TEXT REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS thread_guests_user_idx ON thread_guests (user_id);
