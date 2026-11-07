/**
 * The RP's persistent ECDSA P-256 signing key, used to sign `private_key_jwt`
 * client assertions for the IdP's `POST /rp/notifications`.
 *
 * Stored as a JWK pair in the KV table (D1) under `["rp_signing_key"]` and
 * generated on first use. The public JWK (with `kid`/`use`/`alg`) is published
 * at `/.well-known/jwks.json`; the IdP fetches it to verify our assertions, so
 * we rotate keys simply by replacing the KV value.
 */

import { calculateJwkThumbprint } from "jose";

import type { D1Like } from "@kuboon/kv/d1.ts";
import { kvRepo, setKvForTest as setSharedKv } from "./kv.ts";

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

let rpKeyPromise: Promise<RpKey> | undefined;

/**
 * Override the KV instance (tests use an in-memory one). Also drops the
 * cached key derived from the previous store.
 */
export function setKvForTest(instance: D1Like): void {
  setSharedKv(instance);
  rpKeyPromise = undefined;
}

/** Load (or generate-on-first-use) the RP signing key. Idempotent. */
export function getRpKey(): Promise<RpKey> {
  return rpKeyPromise ??= (async () => {
    // `["rp_signing_key"]`: the repo prefix is empty so the key matches the
    // Deno KV slot it was migrated from.
    const slot = kvRepo<StoredJwkPair>([]).entry("rp_signing_key");

    let stored = await slot.get();
    if (!stored) {
      const pair = await crypto.subtle.generateKey(algo, true, [
        "sign",
        "verify",
      ]);
      stored = {
        publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
        privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
      };
      // Only set if still empty, to avoid racing two generators: the insert
      // is a compare-and-set against "absent", and the loser adopts the
      // winner's key.
      const generated = stored;
      const res = await slot.update((current) => current ?? generated);
      if (!res.ok || !res.val) stored = (await slot.get())!;
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
