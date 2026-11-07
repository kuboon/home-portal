/**
 * Ephemeral invite tokens over the shared KV store (D1).
 *
 * Per the design, an invite is only live while the admin keeps the invite
 * screen open: the token carries a 60s TTL that the screen refreshes with a
 * heartbeat. Stop the heartbeat (close the screen) and it expires within 60s.
 * The token just maps to a home id; accepting it adds the caller as a member.
 */

import { kvRepo } from "./kv.ts";

export { setKvForTest } from "./kv.ts";

export const INVITE_TTL_MS = 60_000;

const invites = kvRepo<string>(["invite"], { expireIn: INVITE_TTL_MS });

/** Create a live invite token for a home. */
export async function createInvite(homeId: string): Promise<string> {
  const token = crypto.randomUUID();
  await invites.entry(token).update(() => homeId);
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

/** The home id a token grants access to, or `null` if expired/unknown. */
export async function resolveInvite(token: string): Promise<string | null> {
  return await invites.entry(token).get();
}

/** Close (revoke) a token immediately. */
export async function closeInvite(token: string): Promise<void> {
  await invites.entry(token).update(() => null);
}
