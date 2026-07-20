-- 0014_image_expiry — attached images auto-expire.
--
-- Attached post images live in storage.kbn.one with a per-object TTL (uploaded
-- with `?expireDays=7`); the storage service deletes them after that. We record
-- the ISO expiry it returns so the UI can show "M/D に削除されます" and, once
-- past, a "deleted" placeholder instead of fetching a gone object. NULL = no
-- expiry (no image, or an image uploaded without a TTL).

ALTER TABLE messages ADD COLUMN image_expires_at TEXT;
