/**
 * Turso (libSQL) client for home portal.
 *
 * Uses the HTTP-only `@libsql/client/web` export so it runs unchanged on
 * Deno Deploy (the native/embedded-replica build pulls in platform binaries
 * and `file:` URLs, neither of which work on the edge or under the Deno web
 * client). For local development run a libSQL server with `turso dev` and
 * point `TURSO_DATABASE_URL` at it (e.g. `http://127.0.0.1:8080`).
 *
 * Configuration comes from the environment:
 * - `TURSO_DATABASE_URL` — libSQL endpoint (http/https/libsql URL).
 * - `TURSO_AUTH_TOKEN`   — auth token (omit for a local `turso dev` server).
 */

import { type Client, createClient } from "@libsql/client/web";

let client: Client | undefined;

/**
 * Return the process-wide libSQL client, creating it on first use.
 *
 * Throws if `TURSO_DATABASE_URL` is not set so misconfiguration fails loudly
 * at the first query rather than silently talking to the wrong database.
 */
export function db(): Client {
  if (client) return client;

  const url = Deno.env.get("TURSO_DATABASE_URL");
  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. For local dev run `turso dev` and " +
        "set TURSO_DATABASE_URL=http://127.0.0.1:8080.",
    );
  }
  const authToken = Deno.env.get("TURSO_AUTH_TOKEN");

  client = createClient({ url, authToken });
  return client;
}
