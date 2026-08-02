/**
 * OAuth 2.1 resource-server side of the MCP endpoint.
 *
 * home portal is a *resource server*: id.kbn.one is the authorization server
 * (it publishes `/.well-known/oauth-authorization-server` and supports CIMD, so
 * MCP clients register themselves by URL — no client secret, no DCR).
 *
 * A client obtains an access token for one specific bot endpoint by asking the
 * IdP for `resource=https://home.kbn.one/mcp/<agentId>` (RFC 8707). The IdP
 * signs an `at+jwt` whose `aud` is that resource. Here we verify the signature
 * against the IdP's JWKS and require `aud` to equal *this* request's endpoint,
 * so a token minted for one bot cannot drive another.
 *
 * `sub` is the human who approved the flow; the caller is only allowed to act
 * as the bot in the URL if they own it (checked by the MCP controller).
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

/** The authorization server: it issues the tokens we accept here. */
export const IDP_ORIGIN: string = Deno.env.get("IDP_ORIGIN") ??
  "https://id.kbn.one";
const RP_ORIGIN = Deno.env.get("RP_ORIGIN") ?? "https://home.kbn.one";

/** The IdP's access-token type header (RFC 9068 style). */
const ACCESS_TOKEN_TYP = "at+jwt";

type KeySet = Parameters<typeof jwtVerify>[1];
const remoteJwks: KeySet = createRemoteJWKSet(
  new URL("/.well-known/jwks.json", IDP_ORIGIN),
);

/** Raised when an access token is missing, invalid, or bound elsewhere. */
export class AccessTokenError extends Error {}

/**
 * The canonical resource identifier for one bot's MCP endpoint — the value a
 * client must pass as `resource` and that we require in `aud`.
 *
 * A path (not a query) so it stays clear of RFC 8707's "SHOULD NOT include a
 * query component" and derives a clean RFC 9728 metadata URL.
 */
export function mcpResourceUri(agentId: string): string {
  return `${RP_ORIGIN}/mcp/${agentId}`;
}

/** RFC 9728 metadata URL for a resource: `/.well-known/...` before the path. */
export function resourceMetadataUrl(agentId: string): string {
  return `${RP_ORIGIN}/.well-known/oauth-protected-resource/mcp/${agentId}`;
}

/**
 * The `WWW-Authenticate` value a 401 from an MCP endpoint must carry so a
 * client can discover where to get a token (RFC 9728 §5.1).
 *
 * `description` is only set when a credential was presented and rejected: a
 * request with no credential at all gets a bare challenge, since RFC 6750 §3.1
 * reserves `error` for tokens that actually failed.
 */
export function challenge(agentId: string, description?: string): string {
  const parts = [
    `Bearer realm="home-portal"`,
    `resource_metadata="${resourceMetadataUrl(agentId)}"`,
  ];
  if (description !== undefined) {
    parts.push(`error="invalid_token"`);
    // `quoted-string` allows neither `"` nor `\`, and the header must stay
    // ASCII; drop anything else rather than emit an unparseable challenge.
    const safe = description.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, " ");
    parts.push(`error_description="${safe}"`);
  }
  return parts.join(", ");
}

/**
 * Verify an IdP-issued access token for `agentId`'s endpoint and return the
 * `sub` (the human who authorized it). Throws {@link AccessTokenError}.
 *
 * `keySet` is injectable for tests; production uses the IdP's remote JWKS.
 */
export async function verifyAccessToken(
  token: string,
  agentId: string,
  keySet: KeySet = remoteJwks,
): Promise<string> {
  if (!token) throw new AccessTokenError("missing access token");

  let payload;
  let protectedHeader;
  try {
    ({ payload, protectedHeader } = await jwtVerify(token, keySet, {
      issuer: IDP_ORIGIN,
      // Bind the token to this exact bot endpoint (RFC 8707 audience).
      audience: mcpResourceUri(agentId),
      algorithms: ["ES256"],
    }));
  } catch (error) {
    throw new AccessTokenError(
      `access token verification failed: ${(error as Error).message}`,
    );
  }

  // Refresh and authorization-request tokens are signed by the same key; the
  // `typ` header is what separates them from access tokens.
  if (protectedHeader.typ !== ACCESS_TOKEN_TYP) {
    throw new AccessTokenError("not an access token");
  }
  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) {
    throw new AccessTokenError("access token has no subject");
  }
  return sub;
}
