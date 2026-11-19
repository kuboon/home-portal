/**
 * Ephemeral invite tokens over the shared KV store (D1).
 *
 * Per the design, an invite is only live while the admin keeps the invite
 * screen open: the token carries a 60s TTL that the screen refreshes with a
 * heartbeat. Stop the heartbeat (close the screen) and it expires within 60s.
 * A home invite maps to a home id; accepting it adds the caller as a member.
 * A thread invite maps to `{homeId, threadId}`; accepting it admits the caller
 * as a guest of that one thread.
 */

import { kvRepo } from "./kv.ts";

export { setKvForTest } from "./kv.ts";

export const INVITE_TTL_MS = 60_000;

/** Stored value: a bare home id (home invite) or a thread target. */
type InviteValue = string | { homeId: string; threadId: string; by?: string };

/** What a live token grants: a home, or a single thread (guest). */
export interface InviteTarget {
  homeId: string;
  /** Set for a thread (guest) invite. */
  threadId: string | null;
  /** Who issued a thread invite (recorded as the guest's `invited_by`). */
  issuedBy: string | null;
}

const invites = kvRepo<InviteValue>(["invite"], { expireIn: INVITE_TTL_MS });

/** Create a live invite token for a home. */
export async function createInvite(homeId: string): Promise<string> {
  const token = crypto.randomUUID();
  await invites.entry(token).update(() => homeId);
  return token;
}

/** Create a live guest invite token for one thread of a home. */
export async function createThreadInvite(
  homeId: string,
  threadId: string,
  issuedBy: string,
): Promise<string> {
  const token = crypto.randomUUID();
  await invites.entry(token).update(() => ({
    homeId,
    threadId,
    by: issuedBy,
  }));
  return token;
}

/** Refresh a token's TTL. Returns false if it has already expired. */
export async function refreshInvite(token: string): Promise<boolean> {
  let live = false;
  await invites.entry(token).update((current) => {
    live = current != null;
    return current; // rewriting re-arms the TTL; null (expired) stays deleted
  });
  return live;
}

/** What a token grants, or `null` if expired/unknown. */
export async function resolveInviteTarget(
  token: string,
): Promise<InviteTarget | null> {
  const value = await invites.entry(token).get();
  if (value == null) return null;
  if (typeof value === "string") {
    return { homeId: value, threadId: null, issuedBy: null };
  }
  return {
    homeId: value.homeId,
    threadId: value.threadId,
    issuedBy: value.by ?? null,
  };
}

/** The home id a token belongs to (home or thread invite), or `null`. */
export async function resolveInvite(token: string): Promise<string | null> {
  return (await resolveInviteTarget(token))?.homeId ?? null;
}

/** Close (revoke) a token immediately. */
export async function closeInvite(token: string): Promise<void> {
  await invites.entry(token).update(() => null);
}
