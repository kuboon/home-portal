-- Key-value store that replaces Deno KV on Cloudflare (sessions, invites,
-- rate limits, RP signing key, recent emoji, notification backoff).
-- Schema matches `@kuboon/kv/d1.ts` (D1KvRepo); `expires_at` is epoch ms and
-- expired rows are swept by the Worker's scheduled handler.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at);
