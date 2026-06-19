/**
 * Verify the IdP-issued, DPoP-bound identity token returned by id.kbn.one's
 * `GET /session` (the `jws` field).
 *
 * The token is an ES256 JWT with `sub` = the IdP user id and `cnf.jkt` = the
 * RFC 7638 thumbprint of the DPoP key it was issued to (RFC 9449 §6). We
 * verify its signature against the IdP's published JWKS and require `cnf.jkt`
 * to equal the thumbprint of the DPoP key proven on THIS request. That makes
 * the user id authoritative: a client can only bind the session to the
 * identity the IdP actually vouches for it — never a self-reported `userId`.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const IDP_ORIGIN = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

/**
 * A verification key for {@link jwtVerify}: either a resolver (the IdP's
 * remote JWKS) or a concrete public key (used by tests).
 */
type KeySet = CryptoKey | Parameters<typeof jwtVerify>[1];
const remoteJwks: KeySet = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", IDP_ORIGIN),
);

/** Raised when an IdP identity token is missing, invalid, or mis-bound. */
export class IdpTokenError extends Error {}

/**
 * Verify `jws` and return the IdP user id it asserts, or throw
 * {@link IdpTokenError}. `expectedThumbprint` must equal the token's
 * `cnf.jkt` — the DPoP key the caller proved possession of on this request.
 *
 * `keySet` is injectable for tests; production uses the IdP's remote JWKS.
 */
export async function verifyIdpIdentity(
  jws: string,
  expectedThumbprint: string,
  keySet: KeySet = remoteJwks,
): Promise<string> {
  if (!jws) throw new IdpTokenError("missing IdP token");

  let payload;
  try {
    ({ payload } = await jwtVerify(
      jws,
      keySet as Parameters<typeof jwtVerify>[1],
      { issuer: IDP_ORIGIN, algorithms: ["ES256"] },
    ));
  } catch (error) {
    throw new IdpTokenError(
      `IdP token verification failed: ${(error as Error).message}`,
    );
  }

  const cnf = payload.cnf as { jkt?: unknown } | undefined;
  if (!cnf || cnf.jkt !== expectedThumbprint) {
    throw new IdpTokenError("IdP token is not bound to this DPoP key");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new IdpTokenError("IdP token has no subject");
  }
  return payload.sub;
}
