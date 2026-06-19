/**
 * New-message notification dispatch.
 *
 * On a new post, notify the thread's home members (except the author) via Web
 * Push (through the IdP). To avoid flooding an active conversation, each
 * (thread, user) pair has an exponential backoff: 1min → 2min → 4min (capped),
 * resetting to 1min after a quiet gap. State lives in Deno KV.
 */

import { getHome, getThread, getUser, listMembers } from "@scope/db";
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

let kvPromise: Promise<Deno.Kv> | undefined;
const kv = (): Promise<Deno.Kv> => (kvPromise ??= Deno.openKv());

async function passesBackoff(
  threadId: string,
  userId: string,
): Promise<boolean> {
  const store = await kv();
  const key = ["notify-backoff", threadId, userId];
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
 * Recipients are the home's members other than the author, gated by backoff.
 */
export async function notifyNewMessage(
  input: { threadId: string; authorId: string; body: string },
): Promise<void> {
  try {
    const thread = await getThread(input.threadId);
    if (!thread) return;
    const [home, members, author] = await Promise.all([
      getHome(thread.homeId),
      listMembers(thread.homeId),
      getUser(input.authorId),
    ]);
    if (!home) return;

    const candidates = members
      .map((m) => m.userId)
      .filter((id) => id !== input.authorId);

    const recipients: string[] = [];
    for (const userId of candidates) {
      if (await passesBackoff(input.threadId, userId)) recipients.push(userId);
    }
    if (recipients.length === 0) return;

    await sendToUsers(recipients, {
      title: home.name,
      body: `${author?.displayName ?? "誰か"}: ${excerpt(input.body)}`,
      url: `${RP_ORIGIN}/homes`,
      tag: input.threadId,
    });
  } catch (error) {
    console.warn("[notify] failed", error);
  }
}
