/**
 * MCP tools — web-parity operations an agent can perform, acting as its own
 * `is_agent` user. Each tool reuses the same DB layer, membership checks, and
 * rate limits as the web UI, so an agent has no more power than a human member.
 */

import {
  canUseStamp,
  createEvent,
  createThread,
  deleteEvent,
  getEvent,
  getMessageContext,
  getRole,
  getThread,
  HomeError,
  listEvents,
  listHomesForUser,
  listHomeStamps,
  listLibrary,
  listMessages,
  listThreads,
  normalizeEvent,
  pickupIntoThread,
  postMessage,
  renameThread,
  repostMessage,
  toggleReaction,
  touchStamp,
  updateEvent,
} from "@scope/db";
import { announceEventChange } from "../calendar.ts";
import { signalMainChannel, signalThread } from "../realtime.ts";
import {
  checkCalendarWriteLimit,
  checkPostLimit,
  checkRepostLimit,
} from "../rate_limit.ts";
import { notifyNewMessage } from "../notify.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
  /** Run the tool as `agentId`. Throw {@link ToolError} for caller errors. */
  handler(agentId: string, args: Record<string, unknown>): Promise<Json>;
}

/** A caller-facing tool error (bad input, not a member, rate limited, …). */
export class ToolError extends Error {}

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value) {
    throw new ToolError(`${key} (string) is required`);
  }
  return value;
};
const optStr = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? args[key] as string : "";

/** Assert the agent is a member of `homeId`, returning its role. */
async function requireMember(homeId: string, agentId: string): Promise<string> {
  const role = await getRole(homeId, agentId);
  if (!role) throw new ToolError("not a member of this home");
  return role;
}

async function homeIdOfThread(threadId: string): Promise<string> {
  const thread = await getThread(threadId);
  if (!thread) throw new ToolError("thread not found");
  if (thread.archivedAt) throw new ToolError("thread is archived (read-only)");
  return thread.homeId;
}

const wrap = (error: unknown): never => {
  if (error instanceof HomeError) throw new ToolError(error.message);
  throw error;
};

/**
 * Load an event by id and assert the agent is a member of *its* home, so an
 * event id can never reach a home the agent is not in. Returns the event and
 * the agent's role there.
 */
async function eventForAgent(eventId: string, agentId: string) {
  const event = await getEvent(eventId);
  if (!event) throw new ToolError("event not found");
  const role = await requireMember(event.homeId, agentId);
  return { event, role };
}

/**
 * For `update_event`: a key present in `args` wins (a string sets it, `null`
 * clears it); an absent key keeps the stored value. `optStr` cannot do this,
 * since it folds both "absent" and "null" into "".
 */
const overlay = (
  args: Record<string, unknown>,
  key: string,
  current: string | null,
): string | null => {
  if (!(key in args)) return current;
  return typeof args[key] === "string" ? args[key] as string : null;
};

/** JSON Schema fragments shared by the event tools. */
const DATE_SCHEMA = {
  type: "string",
  description: "Wall-clock date 'YYYY-MM-DD' (no timezone).",
};
const TIME_SCHEMA = {
  type: ["string", "null"],
  description: "Wall-clock time 'HH:MM'. Give both times, or neither for an " +
    "all-day event.",
};

export const tools: McpTool[] = [
  {
    name: "list_homes",
    description: "List the homes (servers) this agent is a member of.",
    inputSchema: { type: "object", properties: {} },
    handler: (agentId) => listHomesForUser(agentId),
  },
  {
    name: "list_threads",
    description: "List threads in a home the agent belongs to.",
    inputSchema: {
      type: "object",
      properties: { homeId: { type: "string" } },
      required: ["homeId"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      await requireMember(homeId, agentId);
      return await listThreads(homeId);
    },
  },
  {
    name: "list_messages",
    description: "List messages in a thread the agent can access.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const thread = await getThread(threadId);
      if (!thread) throw new ToolError("thread not found");
      const role = await requireMember(thread.homeId, agentId);
      return await listMessages(threadId, agentId, role === "admin");
    },
  },
  {
    name: "create_thread",
    description: "Create a new thread in a home.",
    inputSchema: {
      type: "object",
      properties: { homeId: { type: "string" }, title: { type: "string" } },
      required: ["homeId", "title"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      await requireMember(homeId, agentId);
      try {
        return await createThread({
          homeId,
          title: str(args, "title"),
          userId: agentId,
        });
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "rename_thread",
    description: "Rename a thread (creator, or any admin).",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, title: { type: "string" } },
      required: ["threadId", "title"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const thread = await getThread(threadId);
      if (!thread) throw new ToolError("thread not found");
      const role = await requireMember(thread.homeId, agentId);
      try {
        return await renameThread({
          threadId,
          title: str(args, "title"),
          userId: agentId,
          isAdmin: role === "admin",
        });
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "post_message",
    description:
      "Post a message. Give `threadId` to post in a thread, or `homeId` to " +
      "post in that home's main channel.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Target thread. Omit to post to the main channel.",
        },
        homeId: {
          type: "string",
          description: "Target home, for a main-channel post.",
        },
        body: { type: "string" },
      },
      required: ["body"],
    },
    async handler(agentId, args) {
      // Either a thread (threadId) or the home's main channel (homeId).
      const threadId = optStr(args, "threadId") || null;
      const homeId = threadId
        ? await homeIdOfThread(threadId)
        : str(args, "homeId");
      await requireMember(homeId, agentId);
      if (!(await checkPostLimit(agentId))) throw new ToolError("rate limited");
      try {
        const message = await postMessage({
          homeId,
          threadId,
          authorId: agentId,
          body: str(args, "body"),
        });
        if (threadId) await signalThread(threadId);
        else await signalMainChannel(homeId);
        await notifyNewMessage({
          homeId,
          threadId,
          authorId: agentId,
          body: message.body,
        });
        return message;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "repost_message",
    description:
      "Repost (quote) a message into a thread, with an optional comment.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        sourceMessageId: { type: "string" },
        body: { type: "string" },
      },
      required: ["threadId", "sourceMessageId"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const homeId = await homeIdOfThread(threadId);
      await requireMember(homeId, agentId);
      // Must be able to see the source message — a member of its home — so an
      // agent can't lift content out of a home it doesn't belong to (parity
      // with the web /api repost endpoint).
      const sourceMessageId = str(args, "sourceMessageId");
      const src = await getMessageContext(sourceMessageId);
      if (!src) throw new ToolError("source message not found");
      await requireMember(src.homeId, agentId);
      if (!(await checkRepostLimit(agentId))) {
        throw new ToolError("rate limited");
      }
      try {
        const message = await repostMessage({
          homeId,
          threadId,
          authorId: agentId,
          sourceMessageId,
          body: optStr(args, "body"),
        });
        await signalThread(threadId);
        await notifyNewMessage({
          homeId,
          threadId,
          authorId: agentId,
          body: message.body,
        });
        return message;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "pickup",
    description:
      "Pick up (quote) one or more posts into a thread; the originals' authors " +
      "join the thread as participants.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        sourcePostIds: { type: "array", items: { type: "string" } },
      },
      required: ["threadId", "sourcePostIds"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const homeId = await homeIdOfThread(threadId);
      await requireMember(homeId, agentId);
      const ids = args.sourcePostIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new ToolError("sourcePostIds (array) is required");
      }
      if (!(await checkRepostLimit(agentId))) {
        throw new ToolError("rate limited");
      }
      try {
        const messages = await pickupIntoThread({
          homeId,
          threadId,
          sourcePostIds: ids.map(String),
          authorId: agentId,
        });
        await signalThread(threadId);
        return messages;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "list_stamps",
    description:
      "List stamps (stickers) the agent can post: its own library, or — " +
      "with homeId — every stamp shared in that home (owned by its members).",
    inputSchema: {
      type: "object",
      properties: {
        homeId: {
          type: "string",
          description: "List the home's shared stamps instead of the library.",
        },
      },
    },
    async handler(agentId, args) {
      const homeId = optStr(args, "homeId");
      if (!homeId) return await listLibrary(agentId);
      await requireMember(homeId, agentId);
      return await listHomeStamps(homeId, agentId);
    },
  },
  {
    name: "post_stamp",
    description:
      "Post a stamp (sticker) as a standalone message in a thread. Usable " +
      "stamps are those in the agent's library or owned by a member of the " +
      "thread's home; using one adds it to the agent's library (LRU, max 20).",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, stampId: { type: "string" } },
      required: ["threadId", "stampId"],
    },
    async handler(agentId, args) {
      const threadId = str(args, "threadId");
      const stampId = str(args, "stampId");
      const homeId = await homeIdOfThread(threadId);
      await requireMember(homeId, agentId);
      if (!(await canUseStamp(stampId, agentId, homeId))) {
        throw new ToolError("stamp not found or not usable in this home");
      }
      if (!(await checkPostLimit(agentId))) throw new ToolError("rate limited");
      try {
        const message = await postMessage({
          homeId,
          threadId,
          authorId: agentId,
          stampId,
        });
        await touchStamp(agentId, stampId);
        await signalThread(threadId);
        await notifyNewMessage({
          homeId,
          threadId,
          authorId: agentId,
          body: message.body,
        });
        return message;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "react",
    description: "Toggle an emoji reaction on a message.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" }, emoji: { type: "string" } },
      required: ["messageId", "emoji"],
    },
    async handler(agentId, args) {
      const messageId = str(args, "messageId");
      const ctx = await getMessageContext(messageId);
      if (!ctx) throw new ToolError("message not found");
      await requireMember(ctx.homeId, agentId);
      // Reject archived threads; main-channel messages (no thread) never archive.
      if (ctx.threadId) await homeIdOfThread(ctx.threadId);
      try {
        return await toggleReaction(messageId, agentId, str(args, "emoji"));
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "list_events",
    description: "List a home's calendar events overlapping a date range " +
      "(inclusive). A multi-day event is included if any of its days fall in " +
      "the range. All-day events have null startTime/endTime.",
    inputSchema: {
      type: "object",
      properties: {
        homeId: { type: "string" },
        from: DATE_SCHEMA,
        to: DATE_SCHEMA,
      },
      required: ["homeId", "from", "to"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      await requireMember(homeId, agentId);
      try {
        return await listEvents(homeId, {
          from: str(args, "from"),
          to: str(args, "to"),
        });
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "create_event",
    description: "Add an event to a home's calendar. Omit both times for an " +
      "all-day event. The change is announced in the home's main channel.",
    inputSchema: {
      type: "object",
      properties: {
        homeId: { type: "string" },
        title: { type: "string" },
        startDate: DATE_SCHEMA,
        startTime: TIME_SCHEMA,
        endDate: {
          ...DATE_SCHEMA,
          type: ["string", "null"],
          description: "Last day, 'YYYY-MM-DD'. Omit for a same-day event.",
        },
        endTime: TIME_SCHEMA,
      },
      required: ["homeId", "title", "startDate"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      await requireMember(homeId, agentId);
      const input = {
        title: str(args, "title"),
        startDate: str(args, "startDate"),
        startTime: optStr(args, "startTime"),
        endDate: optStr(args, "endDate"),
        endTime: optStr(args, "endTime"),
      };
      try {
        // Validate before the rate limit (see api/calendar.ts).
        normalizeEvent(input);
        if (!(await checkCalendarWriteLimit(agentId))) {
          throw new ToolError("rate limited");
        }
        const event = await createEvent({ ...input, homeId, userId: agentId });
        await announceEventChange("added", event, agentId);
        return event;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "update_event",
    description: "Change a calendar event. Only the fields you pass change; " +
      "pass null to clear one (null startTime and endTime make it all-day). " +
      "Allowed for the event's creator or a home admin. The change is " +
      "announced in the home's main channel.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        title: { type: "string" },
        startDate: DATE_SCHEMA,
        startTime: TIME_SCHEMA,
        endDate: { ...DATE_SCHEMA, type: ["string", "null"] },
        endTime: TIME_SCHEMA,
      },
      required: ["eventId"],
    },
    async handler(agentId, args) {
      const { event, role } = await eventForAgent(
        str(args, "eventId"),
        agentId,
      );
      const input = {
        title: overlay(args, "title", event.title) ?? "",
        startDate: overlay(args, "startDate", event.startDate) ?? "",
        startTime: overlay(args, "startTime", event.startTime),
        endDate: overlay(args, "endDate", event.endDate),
        endTime: overlay(args, "endTime", event.endTime),
      };
      try {
        normalizeEvent(input); // before the rate limit, as in create_event
        if (!(await checkCalendarWriteLimit(agentId))) {
          throw new ToolError("rate limited");
        }
        const updated = await updateEvent({
          ...input,
          eventId: event.id,
          userId: agentId,
          isAdmin: role === "admin",
        });
        await announceEventChange("updated", updated, agentId);
        return updated;
      } catch (error) {
        return wrap(error);
      }
    },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event. Allowed for the event's creator " +
      "or a home admin. The deletion is announced in the home's main channel.",
    inputSchema: {
      type: "object",
      properties: { eventId: { type: "string" } },
      required: ["eventId"],
    },
    async handler(agentId, args) {
      const { event, role } = await eventForAgent(
        str(args, "eventId"),
        agentId,
      );
      if (!(await checkCalendarWriteLimit(agentId))) {
        throw new ToolError("rate limited");
      }
      try {
        const deleted = await deleteEvent({
          eventId: event.id,
          userId: agentId,
          isAdmin: role === "admin",
        });
        await announceEventChange("deleted", deleted, agentId);
        return { ok: true };
      } catch (error) {
        return wrap(error);
      }
    },
  },
];

export const toolByName = new Map(tools.map((t) => [t.name, t]));
