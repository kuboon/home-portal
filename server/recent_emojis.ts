/**
 * Per-user recently-used reaction emoji (an LRU list) over Deno KV.
 *
 * Keeps the last {@link MAX_RECENT} emoji a user reacted with, most-recent
 * first, so the UI can surface quick picks.
 */

import { getKv as kv } from "./kv.ts";

export const MAX_RECENT = 8;

const key = (userId: string) => ["recent-emoji", userId];

export async function getRecentEmojis(userId: string): Promise<string[]> {
  return (await (await kv()).get<string[]>(key(userId))).value ?? [];
}

/** Record an emoji as most-recently-used (dedup, capped). */
export async function pushRecentEmoji(
  userId: string,
  emoji: string,
): Promise<void> {
  const k = await kv();
  const current = (await k.get<string[]>(key(userId))).value ?? [];
  const next = [emoji, ...current.filter((e) => e !== emoji)].slice(
    0,
    MAX_RECENT,
  );
  await k.set(key(userId), next);
}
