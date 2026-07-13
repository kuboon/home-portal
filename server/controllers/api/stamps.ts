/**
 * /api/stamps — DPoP-protected stamp (sticker) library endpoints.
 *
 * The image itself is uploaded by the browser straight to storage.kbn.one
 * (`POST /upload` with the user's id.kbn.one DPoP token); `create` then only
 * registers the returned object key here. Posting a stamp goes through the
 * regular message endpoints (`{ stampId }` in the post body).
 */

import type { Controller } from "@remix-run/fetch-router";

import {
  createStamp,
  getRole,
  HomeError,
  listHomeStamps,
  listLibrary,
  removeFromLibrary,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import type { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });

export const stampsController = {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ stamps: await listLibrary(userId) });
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const body = await context.request.json() as {
        label?: string;
        storageKey?: string;
        contentType?: string;
      };
      if (!body.storageKey) {
        return Response.json({ error: "storageKey is required" }, {
          status: 400,
        });
      }
      try {
        const stamp = await createStamp({
          ownerId: userId,
          label: body.label,
          storageKey: body.storageKey,
          contentType: body.contentType,
        });
        return Response.json({ stamp }, { status: 201 });
      } catch (error) {
        if (error instanceof HomeError) {
          return Response.json({ error: error.message }, {
            status: error.status,
          });
        }
        throw error;
      }
    },

    async remove(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      await removeFromLibrary(userId, context.params.stampId);
      return Response.json({ ok: true });
    },

    async homeStamps(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) {
        return Response.json({ error: "not a member" }, { status: 403 });
      }
      return Response.json({ stamps: await listHomeStamps(homeId, userId) });
    },
  },
} satisfies Controller<typeof routes.stampsApi>;
