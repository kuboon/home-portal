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
  const response = await fetchDpop(`${idpOrigin}/session`);
  if (response.ok) {
    const data = await response.json() as { userId: string | null };
    userId = data.userId ?? null;
  }

  if (userId) {
    // Bind the IdP identity to this DPoP session + ensure the users row.
    await fetchDpop("/api/users/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch(() => {});
  }

  return { fetchDpop, thumbprint, userId };
}
