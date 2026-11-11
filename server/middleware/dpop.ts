/**
 * DPoP middleware — verifies RFC 9449 DPoP proofs on incoming requests and
 * exposes the session via `context.get(DpopSession)`.
 *
 * Thin wrapper over `@scope/remix-dpop-session-middleware` so controllers can
 * import a pre-configured middleware + re-export the context key from one
 * place. Sessions are persisted in the KV table (D1) with a 1-hour TTL.
 */

import { dpopSession } from "@scope/remix-dpop-session-middleware";
import { createKvSessionStorage } from "@scope/session-storage-kv";
import type { Session } from "@remix-run/session";
import { kvRepo } from "../kv.ts";

export { DpopSession } from "@scope/remix-dpop-session-middleware";

const sessionStorage = createKvSessionStorage(
  kvRepo<Session["data"]>(["dpop-session"], { expireIn: 3_600_000 }),
);

export const dpop = dpopSession({ sessionStorage });
