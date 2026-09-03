/**
 * GET /.well-known/jwks.json — the RP's public JSON Web Key Set (RFC 7517).
 *
 * The IdP fetches this to verify our `private_key_jwt` client assertions when
 * we call `POST /rp/notifications`. Suitable for `jose.createRemoteJWKSet`.
 */

import { createAction } from "@remix-run/fetch-router";
import { getRpKey } from "../rp_key.ts";
import { routes } from "../routes.ts";

export const jwksAction = createAction(routes.jwks, {
  async handler() {
    const { publicJwk } = await getRpKey();
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      headers: {
        "content-type": "application/jwk-set+json",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      },
    });
  },
});
