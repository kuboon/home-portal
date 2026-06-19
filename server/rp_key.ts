/**
 * The RP's persistent ECDSA P-256 signing key, used to sign `private_key_jwt`
 * client assertions for the IdP's `POST /rp/notifications`.
 *
 * Stored as a JWK pair in Deno KV under `["rp_signing_key"]` and generated on
 * first use. The public JWK (with `kid`/`use`/`alg`) is published at
 * `/.well-known/jwks.json`; the IdP fetches it to verify our assertions, so
 * we rotate keys simply by replacing the KV value.
 */

import { calculateJwkThumbprint } from "jose";

const algo = { name: "ECDSA", namedCurve: "P-256" } as const;

interface StoredJwkPair {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

export type PublicJwk = JsonWebKey & {
  kid: string;
  use: "sig";
  alg: "ES256";
};

export interface RpKey {
  /** Private key for signing client assertions (ES256). */
  readonly privateKey: CryptoKey;
  /** RFC 7638 thumbprint of the public key, used as `kid`. */
  readonly kid: string;
  /** Public JWK ready to embed in JWKS. */
  readonly publicJwk: PublicJwk;
}

let kvPromise: Promise<Deno.Kv> | undefined;
const kv = (): Promise<Deno.Kv> => (kvPromise ??= Deno.openKv());

let rpKeyPromise: Promise<RpKey> | undefined;

/** Override the KV instance (tests use an in-memory one). */
export function setKvForTest(instance: Deno.Kv): void {
  kvPromise = Promise.resolve(instance);
  rpKeyPromise = undefined;
}

/** Load (or generate-on-first-use) the RP signing key. Idempotent. */
export function getRpKey(): Promise<RpKey> {
  return rpKeyPromise ??= (async () => {
    const store = await kv();
    const slot = ["rp_signing_key"] as const;

    let stored = (await store.get<StoredJwkPair>(slot)).value;
    if (!stored) {
      const pair = await crypto.subtle.generateKey(algo, true, [
        "sign",
        "verify",
      ]);
      stored = {
        publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
        privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
      };
      // Only set if still empty, to avoid racing two generators.
      const res = await store.atomic().check({ key: slot, versionstamp: null })
        .set(slot, stored).commit();
      if (!res.ok) stored = (await store.get<StoredJwkPair>(slot)).value!;
    }

    const privateKey = await crypto.subtle.importKey(
      "jwk",
      stored.privateKey,
      algo,
      false,
      ["sign"],
    );
    const kid = await calculateJwkThumbprint(stored.publicKey);
    const { kty, crv, x, y } = stored.publicKey;
    const publicJwk: PublicJwk = {
      kty,
      crv,
      x,
      y,
      kid,
      use: "sig",
      alg: "ES256",
    };
    return { privateKey, kid, publicJwk };
  })();
}
