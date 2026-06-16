/**
 * Ephemeral invite tokens over Deno KV.
 *
 * Per the design, an invite is only live while the admin keeps the invite
 * screen open: the token carries a 60s TTL that the screen refreshes with a
 * heartbeat. Stop the heartbeat (close the screen) and it expires within 60s.
 * The token just maps to a home id; accepting it adds the caller as a member.
 */

export const INVITE_TTL_MS = 60_000;

let kvPromise: Promise<Deno.Kv> | undefined;
function kv(): Promise<Deno.Kv> {
  return kvPromise ??= Deno.openKv();
}

/** Override the KV instance (tests use an in-memory one). */
export function setKvForTest(instance: Deno.Kv): void {
  kvPromise = Promise.resolve(instance);
}

const key = (token: string) => ["invite", token];

/** Create a live invite token for a home. */
export async function createInvite(homeId: string): Promise<string> {
  const token = crypto.randomUUID();
  await (await kv()).set(key(token), homeId, { expireIn: INVITE_TTL_MS });
  return token;
}

/** Refresh a token's TTL. Returns false if it has already expired. */
export async function refreshInvite(token: string): Promise<boolean> {
  const k = await kv();
  const entry = await k.get<string>(key(token));
  if (entry.value == null) return false;
  await k.set(key(token), entry.value, { expireIn: INVITE_TTL_MS });
  return true;
}

/** The home id a token grants access to, or `null` if expired/unknown. */
export async function resolveInvite(token: string): Promise<string | null> {
  const entry = await (await kv()).get<string>(key(token));
  return entry.value ?? null;
}

/** Close (revoke) a token immediately. */
export async function closeInvite(token: string): Promise<void> {
  await (await kv()).delete(key(token));
}
