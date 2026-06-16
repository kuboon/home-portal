/**
 * /api — DPoP-protected JSON endpoints.
 *
 * All actions require a valid DPoP proof (see `middleware/dpop.ts`).
 * - GET  /api/me          — returns the session payload (thumbprint + data).
 * - POST /api/users/sync  — records the signed-in IdP user into Turso and
 *                           binds the userId to this DPoP session.
 *
 * NOTE (trust boundary): `syncUser` currently trusts the `userId` the client
 * reports after its IdP sign-in. Hardening this with server-side IdP token
 * introspection is a follow-up; it does not change the data-layer shape.
 */

import type { Controller } from "@remix-run/fetch-router";

import { upsertUser } from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
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
        userId?: string;
        displayName?: string;
      };
      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const user = await upsertUser({
        id: body.userId,
        displayName: body.displayName ?? body.userId,
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
