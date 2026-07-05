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
}

export async function ensureSession(idpOrigin: string): Promise<Session> {
  const { fetchDpop, thumbprint } = await init();

  let userId: string | null = null;
  let jws: string | null = null;
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
      };
      userId = data.userId ?? null;
      jws = data.jws ?? null;
    }
  } catch {
    // Leave userId/jws null → treated as signed-out.
  }

  if (userId && jws) {
    // Bind the IdP identity to this DPoP session + ensure the users row. We
    // forward the IdP's signed, DPoP-bound token; the server verifies it
    // rather than trusting a self-reported userId.
    await fetchDpop("/api/users/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jws }),
    }).catch(() => {});
  }

  return { fetchDpop, thumbprint, userId };
}
