/**
 * /api/invites — DPoP-protected invite-token endpoints.
 *
 * - heartbeat / close: the admin's invite screen keeps the token alive and
 *   revokes it on close. Requires admin of the home the token grants.
 * - accept: any signed-in user redeems a live token. A home invite joins them
 *   as a member; a thread invite admits them as a guest of that thread. The
 *   body may name `as` — an agent the caller owns — to redeem on its behalf
 *   (agents can't sign in, so their owner brings them in).
 */

import { createController } from "@remix-run/fetch-router";

import {
  addGuest,
  addMember,
  getAgentOwner,
  getHome,
  getRole,
  getThread,
  HomeError,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import {
  closeInvite,
  refreshInvite,
  resolveInvite,
  resolveInviteTarget,
} from "../../invites.ts";
import { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });
const expired = () =>
  Response.json({ error: "招待が無効か期限切れです" }, { status: 404 });

export const invitesController = createController(routes.invitesApi, {
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
      const target = await resolveInviteTarget(token);
      if (!target) return expired();
      const body = await context.request.json().catch(() => ({})) as {
        displayName?: string;
        as?: string;
      };
      // Redeem for the caller, or for an agent the caller owns.
      let joinerId = userId;
      if (body.as && body.as !== userId) {
        if (await getAgentOwner(body.as) !== userId) {
          return Response.json(
            { error: "自分のエージェントのみ指定できます" },
            {
              status: 403,
            },
          );
        }
        joinerId = body.as;
      }
      try {
        if (target.threadId) {
          // A member already has access to every thread: nothing to add.
          if (!(await getRole(target.homeId, joinerId))) {
            await addGuest(target.threadId, joinerId, target.issuedBy);
          }
        } else {
          await addMember(target.homeId, joinerId, "member", body.displayName);
        }
      } catch (error) {
        // Already a member is fine — fall through to returning the target.
        if (!(error instanceof HomeError && error.status === 409)) {
          if (error instanceof HomeError) {
            return Response.json({ error: error.message }, {
              status: error.status,
            });
          }
          throw error;
        }
      }
      const home = await getHome(target.homeId);
      const thread = target.threadId ? await getThread(target.threadId) : null;
      return Response.json({ home, thread });
    },
  },
});
