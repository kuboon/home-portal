/**
 * /api/homes/:homeId/events — DPoP-protected calendar endpoints.
 *
 * Any member may list and create; an event may be changed or deleted by its
 * creator or an admin (enforced in `@scope/db`). Every change is announced in
 * the main channel (see `server/calendar.ts`).
 *
 * The routes are nested under the home, so an event's own `homeId` is checked
 * against the path: otherwise a member of home A could reach home B's event
 * through `/api/homes/A/events/<B's id>`. Authorization uses the event's
 * stored home, never the path's, matching how the message endpoints derive
 * the home from the resource.
 */

import { createController } from "@remix-run/fetch-router";

import {
  type CalendarEvent,
  createEvent,
  deleteEvent,
  type EventInput,
  getEvent,
  getRole,
  HomeError,
  listEvents,
  normalizeEvent,
  type Role,
  updateEvent,
} from "@scope/db";
import { announceEventChange } from "../../calendar.ts";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { checkCalendarWriteLimit } from "../../rate_limit.ts";
import { watchCalendar } from "../../realtime.ts";
import { routes } from "../../routes.ts";
import { sseFromWatch } from "../../sse.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });
const forbidden = () =>
  Response.json({ error: "not a member" }, { status: 403 });
const notFound = () => Response.json({ error: "not found" }, { status: 404 });
const rateLimited = () =>
  Response.json(
    { error: "操作が速すぎます。少し待ってください。" },
    { status: 429 },
  );

function handleError(error: unknown): Response {
  if (error instanceof HomeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/** A string field, or null when absent / not a string. */
const field = (body: Record<string, unknown>, key: string): string | null =>
  typeof body[key] === "string" ? body[key] as string : null;

/**
 * Narrow an untrusted JSON body into event fields. Validation of the values
 * themselves lives in `@scope/db` (`normalizeEvent`). PUT replaces the whole
 * event, so an absent time or end means "none".
 */
async function readEventInput(request: Request): Promise<EventInput> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HomeError("invalid JSON body");
  }
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  return {
    title: field(b, "title") ?? "",
    startDate: field(b, "startDate") ?? "",
    startTime: field(b, "startTime"),
    endDate: field(b, "endDate"),
    endTime: field(b, "endTime"),
  };
}

/**
 * Load the event named in the path and the caller's role in its home.
 * Returns a Response when the caller may not proceed.
 */
async function eventForCaller(
  params: { homeId: string; eventId: string },
  userId: string,
): Promise<{ event: CalendarEvent; role: Role } | Response> {
  const event = await getEvent(params.eventId);
  // An event from another home is indistinguishable from a missing one.
  if (!event || event.homeId !== params.homeId) return notFound();
  const role = await getRole(event.homeId, userId);
  if (!role) return forbidden();
  return { event, role };
}

export const calendarController = createController(routes.calendarApi, {
  middleware: [dpop],
  actions: {
    async index(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      const query = new URL(context.request.url).searchParams;
      const from = query.get("from");
      const to = query.get("to");
      if (!from || !to) {
        return Response.json({ error: "from and to are required" }, {
          status: 400,
        });
      }
      try {
        return Response.json({
          events: await listEvents(homeId, { from, to }),
        });
      } catch (error) {
        return handleError(error);
      }
    },

    async show(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const found = await eventForCaller(context.params, userId);
      if (found instanceof Response) return found;
      return Response.json({ event: found.event });
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      try {
        // Validate before the rate limit: a rejected request posts nothing,
        // so it must not make the user's immediate fix fail with 429.
        const input = await readEventInput(context.request);
        normalizeEvent(input);
        if (!(await checkCalendarWriteLimit(userId))) return rateLimited();
        const event = await createEvent({ ...input, homeId, userId });
        await announceEventChange("added", event, userId);
        return Response.json({ event }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async update(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const found = await eventForCaller(context.params, userId);
      if (found instanceof Response) return found;
      try {
        const input = await readEventInput(context.request);
        normalizeEvent(input); // before the rate limit, as in `create`
        if (!(await checkCalendarWriteLimit(userId))) return rateLimited();
        const event = await updateEvent({
          ...input,
          eventId: found.event.id,
          userId,
          isAdmin: found.role === "admin",
        });
        await announceEventChange("updated", event, userId);
        return Response.json({ event });
      } catch (error) {
        return handleError(error);
      }
    },

    async destroy(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const found = await eventForCaller(context.params, userId);
      if (found instanceof Response) return found;
      if (!(await checkCalendarWriteLimit(userId))) return rateLimited();
      try {
        const event = await deleteEvent({
          eventId: found.event.id,
          userId,
          isAdmin: found.role === "admin",
        });
        await announceEventChange("deleted", event, userId);
        return Response.json({ ok: true });
      } catch (error) {
        return handleError(error);
      }
    },

    async stream(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      return sseFromWatch(context.request, watchCalendar(homeId));
    },
  },
});
