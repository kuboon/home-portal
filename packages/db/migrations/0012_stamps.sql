-- 0012_stamps — sticker feature ("stamp", distinct from emoji reactions).
--
-- A stamp is an image a user registers and posts as a standalone message
-- (LINE/Discord sticker). The image itself lives in storage.kbn.one (R2);
-- `storage_key` is the object key returned by its `POST /upload` API, and the
-- browser downloads it from `GET /download?key=…` with the user's id.kbn.one
-- DPoP token.
--
--   stamps       素材マスタ。owner が作成した絵柄。message から参照される
--                ため、ライブラリから外れても行は残す。
--   user_stamps  各ユーザのライブラリ（所持）。上限 20 件・LRU 押し出しは
--                アプリ側（stamps.ts）で `last_used_at` により行う。他人の
--                スタンプを使うと自分のライブラリに自動追加される（共有）。
--
-- messages.stamp_id: kind='stamp' の投稿が絵柄を参照する（logical reference
-- to stamps(id); FK は ALTER を単純に保つため省略 — 0004 と同じ方針）。

CREATE TABLE IF NOT EXISTS stamps (
  id           TEXT PRIMARY KEY,           -- ULID
  owner_id     TEXT NOT NULL REFERENCES users (id),
  label        TEXT NOT NULL,              -- alt text / notification body
  storage_key  TEXT NOT NULL,              -- storage.kbn.one object key
  content_type TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS stamps_owner_idx ON stamps (owner_id);

CREATE TABLE IF NOT EXISTS user_stamps (
  user_id      TEXT NOT NULL REFERENCES users (id),
  stamp_id     TEXT NOT NULL REFERENCES stamps (id),
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, stamp_id)
);

CREATE INDEX IF NOT EXISTS user_stamps_lru_idx
  ON user_stamps (user_id, last_used_at);

ALTER TABLE messages ADD COLUMN stamp_id TEXT;
