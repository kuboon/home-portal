/**
 * Per-user recently-used reaction emoji (an LRU list) over the shared KV
 * store (D1).
 *
 * Keeps the last {@link MAX_RECENT} emoji a user reacted with, most-recent
 * first, so the UI can surface quick picks.
 */

import { kvRepo } from "./kv.ts";

export const MAX_RECENT = 8;

const recent = kvRepo<string[]>(["recent-emoji"]);

export async function getRecentEmojis(userId: string): Promise<string[]> {
  return (await recent.entry(userId).get()) ?? [];
}

/** Record an emoji as most-recently-used (dedup, capped). */
export async function pushRecentEmoji(
  userId: string,
  emoji: string,
): Promise<void> {
  await recent.entry(userId).update((current) =>
    [emoji, ...(current ?? []).filter((e) => e !== emoji)].slice(0, MAX_RECENT)
  );
}
