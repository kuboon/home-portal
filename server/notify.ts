/**
 * New-message notification dispatch.
 *
 * Recipients depend on the channel:
 * - a thread → its `joined` participants (the design's notification scope).
 *   Archived threads have no joined participants, so they notify no one.
 * - the main channel → every home member.
 * The author is always excluded. To avoid flooding an active conversation,
 * each (channel, user) pair has an exponential backoff: 1min → 2min → 4min
 * (capped), resetting after a quiet gap. State lives in Deno KV.
 */

import { getHome, getUser, joinedUserIds, listMembers } from "@scope/db";
import { getKv as kv } from "./kv.ts";
import { RP_ORIGIN, sendToUsers } from "./push_send.ts";

const BASE_MS = 60_000;
const CAP_MS = 240_000;

export interface BackoffState {
  lastSentAt: number;
  intervalMs: number;
}

/**
 * Decide whether to notify now and what the next backoff state is. Pure, so
 * it's unit-testable. First notification always sends; subsequent ones must
 * wait `intervalMs`, which doubles up to {@link CAP_MS}. A gap of at least
 * {@link CAP_MS} resets the interval to {@link BASE_MS}.
 */
export function nextBackoff(
  state: BackoffState | null,
  now: number,
): { send: boolean; next: BackoffState } {
  if (!state) {
    return { send: true, next: { lastSentAt: now, intervalMs: BASE_MS } };
  }
  const elapsed = now - state.lastSentAt;
  if (elapsed < state.intervalMs) return { send: false, next: state };
  const intervalMs = elapsed >= CAP_MS
    ? BASE_MS
    : Math.min(state.intervalMs * 2, CAP_MS);
  return { send: true, next: { lastSentAt: now, intervalMs } };
}

async function passesBackoff(
  channelKey: string,
  userId: string,
): Promise<boolean> {
  const store = await kv();
  const key = ["notify-backoff", channelKey, userId];
  const current = (await store.get<BackoffState>(key)).value;
  const { send, next } = nextBackoff(current, Date.now());
  if (send) await store.set(key, next, { expireIn: CAP_MS * 4 });
  return send;
}

const excerpt = (body: string): string => {
  const trimmed = body.trim();
  if (!trimmed) return "（引用）";
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
};

/**
 * Notify a new message's recipients. Fire-and-forget friendly: never throws.
 * For a thread, recipients are its joined participants; for the main channel
 * (no `threadId`), every home member. The author is excluded; each recipient
 * is gated by backoff.
 */
export async function notifyNewMessage(
  input: {
    homeId: string;
    threadId?: string | null;
    authorId: string;
    body: string;
  },
): Promise<void> {
  try {
    const [home, author] = await Promise.all([
      getHome(input.homeId),
      getUser(input.authorId),
    ]);
    if (!home) return;

    const audience = input.threadId
      ? await joinedUserIds(input.threadId)
      : (await listMembers(input.homeId)).map((m) => m.userId);
    const candidates = audience.filter((id) => id !== input.authorId);

    const channelKey = input.threadId ?? `home:${input.homeId}`;
    const recipients: string[] = [];
    for (const userId of candidates) {
      if (await passesBackoff(channelKey, userId)) recipients.push(userId);
    }
    if (recipients.length === 0) return;

    const url = input.threadId
      ? `${RP_ORIGIN}/home/${input.homeId}/thread/${input.threadId}`
      : `${RP_ORIGIN}/home/${input.homeId}`;

    await sendToUsers(recipients, {
      title: home.name,
      body: `${author?.displayName ?? "誰か"}: ${excerpt(input.body)}`,
      url,
      tag: channelKey,
    });
  } catch (error) {
    console.warn("[notify] failed", error);
  }
}
