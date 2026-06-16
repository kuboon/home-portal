/**
 * /api/homes — DPoP-protected Home + membership endpoints.
 *
 * The acting user is the `userId` bound to the DPoP session (set by
 * `/api/users/sync` after IdP sign-in); requests without it get 401. Mutations
 * that manage membership require the caller to be an admin of the home.
 *
 * Members join either by an admin typing an existing `userId`, or via an
 * ephemeral invite token (`invite` issues one; see `invites.ts`).
 */

import type { Controller } from "@remix-run/fetch-router";

import {
  addMember,
  createHome,
  getRole,
  HomeError,
  listHomesForUser,
  listMembers,
  removeMember,
  type Role,
  setHomeTheme,
  setMemberRole,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { createInvite, INVITE_TTL_MS } from "../../invites.ts";
import { sanitizeThemeCss } from "../../theme.ts";
import type { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });

function handleError(error: unknown): Response {
  if (error instanceof HomeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/** Resolve the caller and assert they are an admin of `homeId`. */
async function requireAdmin(
  session: DpopSession,
  homeId: string,
): Promise<{ userId: string } | Response> {
  const userId = currentUserId(session);
  if (!userId) return unauthorized();
  const role = await getRole(homeId, userId);
  if (!role) return Response.json({ error: "not a member" }, { status: 403 });
  if (role !== "admin") {
    return Response.json({ error: "admin only" }, { status: 403 });
  }
  return { userId };
}

function parseRole(value: unknown): Role | null {
  return value === "admin" || value === "member" ? value : null;
}

export const homesController = {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ homes: await listHomesForUser(userId) });
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const body = await context.request.json() as { name?: string };
      try {
        const home = await createHome({ name: body.name ?? "", userId });
        return Response.json({ home }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async members(context) {
      const session = context.get(DpopSession);
      const userId = currentUserId(session);
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      // Members are visible to members of the home.
      if (!(await getRole(homeId, userId))) {
        return Response.json({ error: "not a member" }, { status: 403 });
      }
      return Response.json({ members: await listMembers(homeId) });
    },

    async addMember(context) {
      const session = context.get(DpopSession);
      const { homeId } = context.params;
      const auth = await requireAdmin(session, homeId);
      if (auth instanceof Response) return auth;
      const body = await context.request.json() as {
        userId?: string;
        role?: string;
      };
      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }
      try {
        const member = await addMember(
          homeId,
          body.userId,
          parseRole(body.role) ?? "member",
        );
        return Response.json({ member }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async setRole(context) {
      const session = context.get(DpopSession);
      const { homeId, userId } = context.params;
      const auth = await requireAdmin(session, homeId);
      if (auth instanceof Response) return auth;
      const body = await context.request.json() as { role?: string };
      const role = parseRole(body.role);
      if (!role) {
        return Response.json({ error: "invalid role" }, { status: 400 });
      }
      try {
        await setMemberRole(homeId, userId, role);
        return Response.json({ ok: true });
      } catch (error) {
        return handleError(error);
      }
    },

    async removeMember(context) {
      const session = context.get(DpopSession);
      const { homeId, userId } = context.params;
      const auth = await requireAdmin(session, homeId);
      if (auth instanceof Response) return auth;
      try {
        await removeMember(homeId, userId);
        return Response.json({ ok: true });
      } catch (error) {
        return handleError(error);
      }
    },

    async invite(context) {
      const session = context.get(DpopSession);
      const { homeId } = context.params;
      const auth = await requireAdmin(session, homeId);
      if (auth instanceof Response) return auth;
      const token = await createInvite(homeId);
      return Response.json({ token, ttlMs: INVITE_TTL_MS }, { status: 201 });
    },

    async setTheme(context) {
      const session = context.get(DpopSession);
      const { homeId } = context.params;
      const auth = await requireAdmin(session, homeId);
      if (auth instanceof Response) return auth;
      const body = await context.request.json() as { css?: string };
      const css = sanitizeThemeCss(body.css ?? "");
      await setHomeTheme(homeId, css);
      return Response.json({ ok: true, themeCss: css });
    },
  },
} satisfies Controller<typeof routes.homesApi>;
