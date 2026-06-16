/**
 * DPoP session middleware for Remix v3 (fetch-router).
 *
 * Mirrors `@remix-run/session-middleware` but identifies sessions by the
 * JWK thumbprint (RFC 7638) of the client's DPoP key (RFC 9449) instead of
 * a signed cookie. The session is exposed on the request context under the
 * `DpopSession` key, so it can be used alongside the regular `Session` key
 * from `@remix-run/session`.
 *
 * ```ts
 * import { dpopSession, DpopSession } from "@scope/remix-dpop-session-middleware";
 * import { createKvSessionStorage } from "@scope/session-storage-kv";
 * import { MemoryKvRepo } from "@scope/kv/memory.ts";
 *
 * const storage = createKvSessionStorage(
 *   new MemoryKvRepo(["dpop-session"], { expireIn: 3_600_000 }),
 * );
 *
 * const router = createRouter({
 *   middleware: [dpopSession({ sessionStorage: storage })],
 * });
 *
 * router.map("/me", ({ get }) => {
 *   const session = get(DpopSession);
 *   return Response.json({ thumbprint: session.thumbprint, data: session.data });
 * });
 * ```
 */

import type { Middleware } from "@remix-run/fetch-router";
import { Session, type SessionStorage } from "@remix-run/session";
import { computeThumbprint } from "@kuboon/dpop/common.ts";
import {
  verifyDpopProofFromRequest,
  type VerifyDpopProofResult,
} from "@kuboon/dpop/server.ts";
import type { VerifyDpopProofOptions } from "@kuboon/dpop/types.ts";

// ---------------------------------------------------------------------------
// DpopSession
// ---------------------------------------------------------------------------

/**
 * A session whose ID is the JWK thumbprint of the client's DPoP key.
 *
 * Subclasses {@link Session} so it works with all the usual Session APIs
 * (`get` / `set` / `flash` / `destroy` / etc.). Adds the verified `jwk`
 * and a `thumbprint` alias for `id`.
 *
 * Used as a context key — `context.get(DpopSession)` returns the instance.
 * Coexists with `@remix-run/session`'s `Session` key.
 */
export class DpopSession extends Session {
  readonly jwk: JsonWebKey;

  constructor(
    thumbprint: string,
    jwk: JsonWebKey,
    initialData?: Session["data"],
  ) {
    super(thumbprint, initialData);
    this.jwk = jwk;
  }

  /** Alias for {@link Session.id} — the JWK thumbprint of the bound key. */
  get thumbprint(): string {
    return this.id;
  }

  /**
   * Regenerating the session ID is not supported for DPoP sessions: the ID
   * is derived from the client's key, not chosen by the server.
   */
  override regenerateId(_deleteOldSession?: boolean): void {
    throw new Error(
      "Cannot regenerate ID of a DpopSession — the ID is derived from the client key",
    );
  }
}

// ---------------------------------------------------------------------------
// Replay detector
// ---------------------------------------------------------------------------

export interface ReplayDetector {
  /** Return true if the jti is acceptable (not replayed). */
  check(jti: string): boolean | Promise<boolean>;
}

export class InMemoryReplayDetector implements ReplayDetector {
  private seen = new Set<string>();
  check(jti: string): boolean {
    if (this.seen.has(jti)) return false;
    this.seen.add(jti);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface DpopSessionMiddlewareOptions {
  /** Storage backend for session data (typically `createKvSessionStorage`). */
  sessionStorage: SessionStorage;
  /** Detects replayed `jti` values. Defaults to an in-memory detector. */
  replayDetector?: ReplayDetector;
  /** Maximum age of a DPoP proof in seconds. Defaults to 300 (5 minutes). */
  maxAgeSeconds?: number;
  /** Allowed clock skew when validating `iat`. Defaults to 60 seconds. */
  clockSkewSeconds?: number;
  /**
   * Build the response returned when DPoP verification fails. Defaults to a
   * 401 with `{ error }` JSON.
   */
  onError?: (error: string, request: Request) => Response | Promise<Response>;
}

type SetDpopSessionContextTransform = readonly [
  readonly [typeof DpopSession, DpopSession],
];

/**
 * Middleware that verifies the DPoP proof on every request and exposes a
 * persistent {@link DpopSession} on the request context.
 *
 * Pair this with `@remix-run/session-middleware` if you also need a regular
 * cookie session — they use different context keys (`Session` vs
 * `DpopSession`) and do not interfere.
 *
 * @param options Middleware configuration
 * @returns The DPoP session middleware
 */
export function dpopSession(
  options: DpopSessionMiddlewareOptions,
  // deno-lint-ignore no-explicit-any
): Middleware<any, any, SetDpopSessionContextTransform> {
  const { sessionStorage } = options;
  const replayDetector = options.replayDetector ?? new InMemoryReplayDetector();
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const clockSkewSeconds = options.clockSkewSeconds ?? 60;
  const onError = options.onError ?? defaultOnError;

  const verifyOptions: VerifyDpopProofOptions = {
    maxAgeSeconds,
    clockSkewSeconds,
    checkReplay: (jti: string) => replayDetector.check(jti),
  };

  return async (context, next) => {
    if (context.has(DpopSession)) {
      throw new Error("Existing DPoP session found, refusing to overwrite");
    }

    const result: VerifyDpopProofResult = await verifyDpopProofFromRequest(
      context.request,
      verifyOptions,
    );
    if (!result.valid) {
      return onError(result.error, context.request);
    }

    const thumbprint = await computeThumbprint(result.jwk);

    // Read existing data from storage. We only consume `.data` so the
    // returned session's id (which may differ if the storage was not
    // configured with `useUnknownIds`) is irrelevant — we always rebuild
    // the session keyed by the thumbprint.
    const stored = await sessionStorage.read(thumbprint);
    const session = new DpopSession(thumbprint, result.jwk, stored.data);

    context.set(DpopSession, session);

    const response = await next();

    if (session !== context.get(DpopSession)) {
      throw new Error(
        "Cannot save DPoP session that was initialized by another middleware/handler",
      );
    }

    await sessionStorage.save(session);

    return response;
  };
}

function defaultOnError(error: string, _request: Request): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
