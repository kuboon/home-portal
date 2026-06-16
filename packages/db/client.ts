/**
 * Turso (libSQL) client for home portal.
 *
 * The implementation is chosen from `TURSO_DATABASE_URL`:
 * - `:memory:` / `file:…` → the native `@libsql/client` (embedded SQLite),
 *   used for tests and local files.
 * - `http(s)://` / `libsql://` → the edge-safe `@libsql/client/web`
 *   (HTTP-only, no native deps), so it runs unchanged on Deno Deploy.
 *
 * The native client is loaded lazily via dynamic import, so production
 * (which talks to a hosted libSQL over HTTP) never pulls in platform
 * binaries. For local development run `turso dev` and point the URL at it
 * (e.g. `http://127.0.0.1:8080`).
 */

import type { Client } from "@libsql/client/web";

let clientPromise: Promise<Client> | undefined;

/**
 * Return the process-wide libSQL client, creating it on first use.
 *
 * Throws if `TURSO_DATABASE_URL` is not set so misconfiguration fails loudly
 * at the first query rather than silently talking to the wrong database.
 */
export function db(): Promise<Client> {
  if (!clientPromise) clientPromise = create();
  return clientPromise;
}

async function create(): Promise<Client> {
  const url = Deno.env.get("TURSO_DATABASE_URL");
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. For local dev run `turso dev` and " +
        "set TURSO_DATABASE_URL=http://127.0.0.1:8080 (tests use :memory:).",
    );
  }
  const authToken = Deno.env.get("TURSO_AUTH_TOKEN");

  const embedded = url === ":memory:" || url.startsWith("file:");
  const { createClient } = embedded
    ? await import("@libsql/client")
    : await import("@libsql/client/web");

  return createClient({ url, authToken });
}

/** Reset the memoized client. For tests that need a fresh in-memory DB. */
export function resetClient(): void {
  clientPromise = undefined;
}
