/**
 * Browser-side session bootstrap shared by client entries.
 *
 * `ensureSession` generates/loads the DPoP key, asks the IdP who we are, and
 * (when signed in) binds that identity to the home portal session via
 * `POST /api/users/sync`. The returned `fetchDpop` signs requests to both the
 * IdP and home portal's own DPoP-protected `/api` endpoints.
 *
 * Browser-only (DPoP key gen uses IndexedDB) — call from a `typeof document
 * !== "undefined"` branch.
 */

import { init } from "@kuboon/dpop";

export type FetchDpop = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface Session {
  fetchDpop: FetchDpop;
  thumbprint: string;
  userId: string | null;
  /**
   * The IdP's DPoP-bound access token (`jws`), or null when signed out.
   * Sent as `Authorization: Bearer …` (plus the DPoP proof `fetchDpop` adds)
   * to other resource servers that verify id.kbn.one users — e.g.
   * storage.kbn.one's upload/download API for stamp images.
   */
  accessToken: string | null;
  /**
   * The signed-in user's display name: the IdP's `nickname` when they've set
   * one, else our `users` row's display name. `null` when signed out, and also
   * when the only name on file is the bare userId — callers use this to
   * prefill a display-name field, and a userId is not a name anyone would
   * keep, so an empty field beats a wrong default.
   */
  displayName: string | null;
}

export async function ensureSession(idpOrigin: string): Promise<Session> {
  const { fetchDpop, thumbprint } = await init();

  let userId: string | null = null;
  let jws: string | null = null;
  let displayName: string | null = null;
  // Probing the IdP must never sink the whole bootstrap: a network/CORS error
  // or a non-OK response just means "not signed in". We still return the
  // `thumbprint` from init() so callers can start the `/authorize` sign-in
  // flow (it goes into `dpop_jkt`) — that was the whole point of getting here.
  try {
    const response = await fetchDpop(`${idpOrigin}/session`);
    if (response.ok) {
      const data = await response.json() as {
        userId: string | null;
        jws?: string;
        nickname?: string | null;
      };
      userId = data.userId ?? null;
      jws = data.jws ?? null;
      // The IdP's user-level nickname (null when they haven't set one). It also
      // rides on the `jws` as a claim, but this is only ever a UI default, so
      // reading the plain field is fine.
      displayName = data.nickname?.trim() || null;
    }
  } catch {
    // Leave userId/jws null → treated as signed-out.
  }

  if (userId && jws) {
    // Bind the IdP identity to this DPoP session + ensure the users row. We
    // forward the IdP's signed, DPoP-bound token; the server verifies it
    // rather than trusting a self-reported userId.
    const synced = await fetchDpop("/api/users/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Carry the IdP nickname through so the `users` row reflects it instead
      // of falling back to the bare userId.
      body: JSON.stringify(displayName ? { jws, displayName } : { jws }),
    }).catch(() => null);
    // No nickname at the IdP → fall back to the `users` row's display name.
    // That row is seeded with the bare userId when nothing better is known,
    // and a userId is not a name a person would choose: offering it as the
    // default just makes them clear the field first, so report "no name" and
    // let callers show an empty field instead.
    if (!displayName && synced?.ok) {
      const data = await synced.json().catch(() => null) as
        | { user?: { displayName?: string } }
        | null;
      const stored = data?.user?.displayName?.trim();
      displayName = stored && stored !== userId ? stored : null;
    }
  }

  return { fetchDpop, thumbprint, userId, accessToken: jws, displayName };
}
