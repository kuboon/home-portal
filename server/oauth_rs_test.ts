import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CompactSign, type JWTVerifyGetKey } from "jose";
import {
  AccessTokenError,
  challenge,
  IDP_ORIGIN,
  mcpResourceUri,
  resourceMetadataUrl,
  verifyAccessToken,
} from "./oauth_rs.ts";

const AGENT = "agent_01TESTTESTTESTTESTTESTTEST";

const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
/** The production key set is a remote JWKS lookup; here it is one fixed key. */
const keySet: JWTVerifyGetKey = () => keyPair.publicKey;

/** Sign a token the way the IdP does: claims in the body, `typ` in the header. */
function mint(
  claims: Record<string, unknown>,
  typ = "at+jwt",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new CompactSign(
    new TextEncoder().encode(JSON.stringify({
      iss: IDP_ORIGIN,
      sub: "human1",
      aud: mcpResourceUri(AGENT),
      iat: now,
      exp: now + 3600,
      ...claims,
    })),
  )
    .setProtectedHeader({ alg: "ES256", typ, kid: "test" })
    .sign(keyPair.privateKey);
}

async function rejects(token: string): Promise<string> {
  try {
    await verifyAccessToken(token, AGENT, keySet);
  } catch (error) {
    assert(error instanceof AccessTokenError, `unexpected error: ${error}`);
    return error.message;
  }
  throw new Error("expected the token to be rejected");
}

Deno.test("mcpResourceUri / resourceMetadataUrl derive the RFC 9728 pair", () => {
  const resource = mcpResourceUri(AGENT);
  assert(resource.endsWith(`/mcp/${AGENT}`));
  const metadata = new URL(resourceMetadataUrl(AGENT));
  assertEquals(
    metadata.pathname,
    `/.well-known/oauth-protected-resource/mcp/${AGENT}`,
  );
  assertEquals(metadata.origin, new URL(resource).origin);
});

Deno.test("challenge points at the resource metadata", () => {
  const bare = challenge(AGENT);
  assertStringIncludes(
    bare,
    `resource_metadata="${resourceMetadataUrl(AGENT)}"`,
  );
  // No credential was presented, so no `error` code (RFC 6750 §3.1).
  assert(!bare.includes("error="));

  const rejected = challenge(AGENT, 'bad "token"\n');
  assertStringIncludes(rejected, `error="invalid_token"`);
  // The description must stay a legal quoted-string: no `"`, no control chars.
  const description = rejected.match(/error_description="([^"]*)"$/);
  assert(description, `no parsable description in: ${rejected}`);
  const illegal = [...description[1]].some((c) => {
    const code = c.codePointAt(0)!;
    return c === "\\" || code < 0x20 || code > 0x7e;
  });
  assert(!illegal, `illegal characters in: ${description[1]}`);
});

Deno.test("verifyAccessToken accepts a token minted for this agent", async () => {
  assertEquals(
    await verifyAccessToken(await mint({}), AGENT, keySet),
    "human1",
  );
});

Deno.test("verifyAccessToken rejects a token minted for another agent", async () => {
  const token = await mint({ aud: mcpResourceUri("agent_SOMEONEELSE") });
  assertStringIncludes(await rejects(token), "aud");
});

Deno.test("verifyAccessToken rejects a token from another issuer", async () => {
  assertStringIncludes(
    await rejects(await mint({ iss: "https://evil.example" })),
    "iss",
  );
});

Deno.test("verifyAccessToken rejects a non-access token with the same signature", async () => {
  // Refresh and authorization-request tokens are signed by the same key; only
  // the `typ` header separates them.
  assertEquals(await rejects(await mint({}, "rt+jwt")), "not an access token");
});

Deno.test("verifyAccessToken rejects an expired token", async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  assertStringIncludes(await rejects(await mint({ exp: past })), "exp");
});

Deno.test("verifyAccessToken rejects a token with no subject", async () => {
  assertEquals(
    await rejects(await mint({ sub: undefined })),
    "access token has no subject",
  );
});

Deno.test("verifyAccessToken rejects garbage", async () => {
  assertEquals(await rejects(""), "missing access token");
  assertStringIncludes(await rejects("not-a-jwt"), "verification failed");
});
