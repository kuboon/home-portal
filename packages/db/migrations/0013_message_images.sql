-- 0013_message_images — image attachment on a chat message (画像 post).
--
-- Distinct from a stamp (a standalone `kind='stamp'` post): an image post is a
-- normal message that carries an attached image, with an optional text body as
-- a caption. The bytes live in storage.kbn.one (same as stamps); we store only
-- the object key plus its content type and natural dimensions (so the client
-- can reserve the right aspect ratio before the image loads).
--
-- A message has at most one image (MVP). `image_key IS NULL` means no image.
-- The 10MB / 4096px-longest-edge limits are enforced client-side at upload
-- (storage.kbn.one caps at 500MB); the server just records the key.

ALTER TABLE messages ADD COLUMN image_key TEXT;
ALTER TABLE messages ADD COLUMN image_type TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN image_w INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN image_h INTEGER NOT NULL DEFAULT 0;
