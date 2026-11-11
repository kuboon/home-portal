/**
 * Per-user rate limiting over the shared KV table in D1 (fixed-window
 * counters).
 *
 * Design limits: posts 1/sec and 20/min; reposts (pickup) are excluded from
 * the post limits but capped at 5/min. Each window is a row keyed by
 * `floor(now / windowMs)`; it expires after two windows and the scheduled
 * sweep deletes it. This is approximate (boundary effects) but cheap.
 */

import { type D1Like, encodeKey } from "@kuboon/kv/d1.ts";
import { kvDb } from "./kv.ts";

/**
 * Consume one unit against a fixed window. Returns false when over limit.
 *
 * A single conditional upsert does the read-check-increment atomically on
 * D1's primary, so concurrent requests can't both slip past the limit and a
 * post costs one round trip per window. The row uses the `kv` table layout
 * (JSON-encoded number) so it is swept like any other expiring entry.
 */
export async function allow(
  db: D1Like,
  parts: string[],
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const bucket = Math.floor(now / windowMs);
  const row = await db
    .prepare(
      "INSERT INTO kv (key, value, version, expires_at) VALUES (?1, '1', 1, ?2) " +
        "ON CONFLICT (key) DO UPDATE SET " +
        "value = CAST(CAST(kv.value AS INTEGER) + 1 AS TEXT), " +
        "version = kv.version + 1 " +
        "WHERE CAST(kv.value AS INTEGER) < ?3 " +
        "RETURNING value",
    )
    .bind(encodeKey([...parts, bucket]), now + windowMs * 2, limit)
    .first<{ value: string }>();
  return row !== null;
}

/** True if the user may post now (1/sec AND 20/min). */
export async function checkPostLimit(userId: string): Promise<boolean> {
  // Check the per-second window first: a burst is rejected here without
  // draining the per-minute budget, which only ~1/sec posts should consume.
  if (!(await allow(kvDb, ["rl", "post-sec", userId], 1, 1_000))) return false;
  return await allow(kvDb, ["rl", "post-min", userId], 20, 60_000);
}

/** True if the user may repost now (5/min, separate from post limits). */
export async function checkRepostLimit(userId: string): Promise<boolean> {
  return await allow(kvDb, ["rl", "repost-min", userId], 5, 60_000);
}
