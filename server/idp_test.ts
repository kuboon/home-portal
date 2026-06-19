import { assertEquals, assertRejects } from "@std/assert";
import { generateKeyPair, SignJWT } from "jose";
import { IdpTokenError, verifyIdpIdentity } from "./idp.ts";

const IDP_ORIGIN = "https://id.kbn.one";
const THUMBPRINT = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF"; // 43 chars

const { publicKey, privateKey } = await generateKeyPair("ES256");

function token(
  claims: Record<string, unknown>,
  opts: { exp?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(IDP_ORIGIN)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(privateKey);
}

Deno.test("verifyIdpIdentity returns sub when cnf.jkt matches", async () => {
  const jws = await token({ sub: "user-1", cnf: { jkt: THUMBPRINT } });
  assertEquals(await verifyIdpIdentity(jws, THUMBPRINT, publicKey), "user-1");
});

Deno.test("verifyIdpIdentity rejects a token bound to a different key", async () => {
  const jws = await token({ sub: "user-1", cnf: { jkt: THUMBPRINT } });
  await assertRejects(
    () => verifyIdpIdentity(jws, "some-other-thumbprint", publicKey),
    IdpTokenError,
    "not bound",
  );
});

Deno.test("verifyIdpIdentity rejects a token without cnf binding", async () => {
  const jws = await token({ sub: "user-1" });
  await assertRejects(
    () => verifyIdpIdentity(jws, THUMBPRINT, publicKey),
    IdpTokenError,
    "not bound",
  );
});

Deno.test("verifyIdpIdentity rejects a token with no subject", async () => {
  const jws = await token({ cnf: { jkt: THUMBPRINT } });
  await assertRejects(
    () => verifyIdpIdentity(jws, THUMBPRINT, publicKey),
    IdpTokenError,
    "no subject",
  );
});

Deno.test("verifyIdpIdentity rejects a token signed by the wrong key", async () => {
  const { privateKey: otherKey } = await generateKeyPair("ES256");
  const jws = await new SignJWT({ sub: "user-1", cnf: { jkt: THUMBPRINT } })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(IDP_ORIGIN)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(otherKey);
  await assertRejects(
    () => verifyIdpIdentity(jws, THUMBPRINT, publicKey),
    IdpTokenError,
    "verification failed",
  );
});

Deno.test("verifyIdpIdentity rejects a wrong issuer", async () => {
  const jws = await new SignJWT({ sub: "user-1", cnf: { jkt: THUMBPRINT } })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer("https://evil.example")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  await assertRejects(
    () => verifyIdpIdentity(jws, THUMBPRINT, publicKey),
    IdpTokenError,
    "verification failed",
  );
});

Deno.test("verifyIdpIdentity rejects an empty token", async () => {
  await assertRejects(
    () => verifyIdpIdentity("", THUMBPRINT, publicKey),
    IdpTokenError,
    "missing",
  );
});
