/**
 * /api — DPoP-protected JSON endpoints.
 *
 * All actions require a valid DPoP proof (see `middleware/dpop.ts`).
 * - GET  /api/me          — returns the session payload (thumbprint + data).
 * - POST /api/users/sync  — binds the signed-in IdP user to this DPoP session
 *                           and records them in Turso.
 *
 * `syncUser` does NOT trust a client-reported userId. The client sends the
 * IdP-issued, DPoP-bound identity token (`jws` from id.kbn.one's GET /session)
 * and we verify it against the IdP's JWKS, requiring its `cnf.jkt` to match
 * this request's DPoP thumbprint. The userId is taken from the verified token.
 */

import type { Controller } from "@remix-run/fetch-router";

import { upsertUser } from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { IdpTokenError, verifyIdpIdentity } from "../../idp.ts";
import type { routes } from "../../routes.ts";

export const apiController = {
  middleware: [dpop],
  actions: {
    me(context) {
      const session = context.get(DpopSession);
      const [data] = session.data;
      return Response.json({
        thumbprint: session.thumbprint,
        sessionData: data,
      });
    },

    async syncUser(context) {
      const session = context.get(DpopSession);
      const body = await context.request.json() as {
        jws?: string;
        displayName?: string;
      };
      if (!body.jws) {
        return Response.json({ error: "jws is required" }, { status: 400 });
      }

      let userId: string;
      try {
        userId = await verifyIdpIdentity(body.jws, session.thumbprint);
      } catch (error) {
        if (error instanceof IdpTokenError) {
          return Response.json({ error: error.message }, { status: 401 });
        }
        throw error;
      }

      // displayName is only ever the caller's own (userId comes from the
      // verified token), so accepting it from the body is harmless.
      const user = await upsertUser({
        id: userId,
        displayName: body.displayName ?? userId,
      });
      session.set("userId", user.id);

      return Response.json({
        ok: true,
        user,
        thumbprint: session.thumbprint,
      });
    },
  },
} satisfies Controller<typeof routes.api>;
