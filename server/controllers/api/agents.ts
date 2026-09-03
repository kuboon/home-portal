/**
 * /api/agents — DPoP-protected agent management for the signed-in human.
 *
 * An agent is a user (`is_agent = 1`) owned by the caller, authenticating to
 * the MCP server with a bearer token. The token is returned once at creation
 * (only its hash is stored). Per-home role is via `memberships`, like any user.
 *
 * `POST /api/agents` takes an optional `homeId`: the agent is then added to
 * that home in the same request (the caller must be its admin), so creating an
 * agent from a home's settings needs no separate "add by id" step.
 */

import { createController } from "@remix-run/fetch-router";

import {
  addMember,
  createAgent,
  deleteAgent,
  getRole,
  HomeError,
  listAgentsByOwner,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });

export const agentsController = createController(routes.agentsApi, {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ agents: await listAgentsByOwner(userId) });
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const body = await context.request.json() as {
        displayName?: string;
        homeId?: string;
      };
      const homeId = body.homeId?.trim();
      // Adding a member is an admin action, so check before creating anything.
      if (homeId && await getRole(homeId, userId) !== "admin") {
        return Response.json({ error: "admin only" }, { status: 403 });
      }
      try {
        const { agent, token } = await createAgent({
          ownerId: userId,
          displayName: body.displayName ?? "",
        });
        if (homeId) await addMember(homeId, agent.id, "member");
        // `token` is returned only here; only its hash is stored.
        return Response.json({ agent, token, homeId: homeId ?? null }, {
          status: 201,
        });
      } catch (error) {
        if (error instanceof HomeError) {
          return Response.json({ error: error.message }, {
            status: error.status,
          });
        }
        throw error;
      }
    },

    async delete(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { agentId } = context.params;
      const ok = await deleteAgent(userId, agentId);
      if (!ok) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true });
    },
  },
});
