/**
 * Per-user rate limiting over Deno KV (fixed-window counters).
 *
 * Design limits: posts 1/sec and 20/min; reposts (pickup) are excluded from
 * the post limits but capped at 5/min. Each window is a bucket keyed by
 * `floor(now / windowMs)`; the counter expires after two windows so old
 * buckets clean themselves up. This is approximate (boundary effects) but
 * cheap and fans out across Deno Deploy isolates.
 */

/** Consume one unit against a fixed window. Returns false when over limit. */
export async function allow(
  kv: Deno.Kv,
  parts: Deno.KvKeyPart[],
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const bucket = Math.floor(now / windowMs);
  const key = [...parts, bucket];
  const current = (await kv.get<number>(key)).value ?? 0;
  if (current >= limit) return false;
  await kv.set(key, current + 1, { expireIn: windowMs * 2 });
  return true;
}

let kvPromise: Promise<Deno.Kv> | undefined;
function sharedKv(): Promise<Deno.Kv> {
  return kvPromise ??= Deno.openKv();
}

/** True if the user may post now (1/sec AND 20/min). */
export async function checkPostLimit(userId: string): Promise<boolean> {
  const kv = await sharedKv();
  if (!(await allow(kv, ["rl", "post-min", userId], 20, 60_000))) return false;
  return await allow(kv, ["rl", "post-sec", userId], 1, 1_000);
}

/** True if the user may repost now (5/min, separate from post limits). */
export async function checkRepostLimit(userId: string): Promise<boolean> {
  const kv = await sharedKv();
  return await allow(kv, ["rl", "repost-min", userId], 5, 60_000);
}
