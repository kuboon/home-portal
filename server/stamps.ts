/**
 * Per-user recently-used stamps (an LRU "stamp library") over Deno KV.
 *
 * Keeps the last {@link MAX_RECENT} stamps a user reacted with, most-recent
 * first, so the UI can surface quick picks.
 */

import { getKv as kv } from "./kv.ts";

export const MAX_RECENT = 8;

const key = (userId: string) => ["stamp-recent", userId];

export async function getRecentStamps(userId: string): Promise<string[]> {
  return (await (await kv()).get<string[]>(key(userId))).value ?? [];
}

/** Record a stamp as most-recently-used (dedup, capped). */
export async function pushRecentStamp(
  userId: string,
  stamp: string,
): Promise<void> {
  const k = await kv();
  const current = (await k.get<string[]>(key(userId))).value ?? [];
  const next = [stamp, ...current.filter((s) => s !== stamp)].slice(
    0,
    MAX_RECENT,
  );
  await k.set(key(userId), next);
}
