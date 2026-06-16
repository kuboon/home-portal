/**
 * /api/invites — DPoP-protected invite-token endpoints.
 *
 * - heartbeat / close: the admin's invite screen keeps the token alive and
 *   revokes it on close. Requires admin of the home the token grants.
 * - accept: any signed-in user redeems a live token to join as a member.
 */

import type { Controller } from "@remix-run/fetch-router";

import { addMember, getHome, getRole, HomeError } from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { closeInvite, refreshInvite, resolveInvite } from "../../invites.ts";
import type { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });
const expired = () =>
  Response.json({ error: "招待が無効か期限切れです" }, { status: 404 });

export const invitesController = {
  middleware: [dpop],
  actions: {
    async heartbeat(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { token } = context.params;
      const homeId = await resolveInvite(token);
      if (!homeId) return expired();
      if (await getRole(homeId, userId) !== "admin") {
        return Response.json({ error: "admin only" }, { status: 403 });
      }
      await refreshInvite(token);
      return Response.json({ ok: true });
    },

    async close(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { token } = context.params;
      const homeId = await resolveInvite(token);
      // Already gone — closing is idempotent.
      if (!homeId) return Response.json({ ok: true });
      if (await getRole(homeId, userId) !== "admin") {
        return Response.json({ error: "admin only" }, { status: 403 });
      }
      await closeInvite(token);
      return Response.json({ ok: true });
    },

    async accept(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { token } = context.params;
      const homeId = await resolveInvite(token);
      if (!homeId) return expired();
      try {
        await addMember(homeId, userId, "member");
      } catch (error) {
        // Already a member is fine — fall through to returning the home.
        if (!(error instanceof HomeError && error.status === 409)) {
          if (error instanceof HomeError) {
            return Response.json({ error: error.message }, {
              status: error.status,
            });
          }
          throw error;
        }
      }
      return Response.json({ home: await getHome(homeId) });
    },
  },
} satisfies Controller<typeof routes.invitesApi>;
