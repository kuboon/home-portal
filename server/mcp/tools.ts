/**
 * MCP tools — web-parity operations an agent can perform, acting as its own
 * `is_agent` user. Each tool reuses the same DB layer, membership checks, and
 * rate limits as the web UI, so an agent has no more power than a human member.
 * An agent can also be a guest of a single thread in another home (its owner
 * redeemed a thread invite for it): thread-scoped tools then work there, while
 * home-scoped ones (main channel, create_thread, pickup) stay members only.
 */

import {
  canUseStamp,
  createThread,
  getMessageContext,
  getRole,
  getThread,
  getThreadAccess,
  HomeError,
  listGuestThreads,
  listHomesForUser,
  listHomeStamps,
  listLibrary,
  listMessages,
  listThreads,
  pickupIntoThread,
  postMessage,
  renameThread,
  repostMessage,
  toggleReaction,
  touchStamp,
} from "@scope/db";
import { signalMainChannel, signalThread } from "../realtime.ts";
import { checkPostLimit, checkRepostLimit } from "../rate_limit.ts";
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

/** Assert the agent can access a thread (member or guest), returning its role. */
async function requireThreadAccess(
  threadId: string,
  agentId: string,
): Promise<string> {
  const access = await getThreadAccess(threadId, agentId);
  if (!access) {
    if (!(await getThread(threadId))) throw new ToolError("thread not found");
    throw new ToolError("no access to this thread");
  }
  return access.role;
}

/** Assert access to a message's channel (thread access, or main = members). */
async function requireChannelAccess(
  ctx: { homeId: string; threadId: string | null },
  agentId: string,
): Promise<string> {
  return ctx.threadId
    ? await requireThreadAccess(ctx.threadId, agentId)
    : await requireMember(ctx.homeId, agentId);
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

export const tools: McpTool[] = [
  {
    name: "list_homes",
    description:
      "List the homes (servers) this agent is a member of, plus homes where " +
      "it is a guest of some thread (`guest: true`, role 'guest').",
    inputSchema: { type: "object", properties: {} },
    async handler(agentId) {
      const homes: Json[] = (await listHomesForUser(agentId)).map((h) => ({
        ...h,
        guest: false,
      }));
      const seen = new Set(homes.map((h) => h.id));
      for (const g of await listGuestThreads(agentId)) {
        if (seen.has(g.home.id)) continue;
        seen.add(g.home.id);
        homes.push({
          id: g.home.id,
          name: g.home.name,
          role: "guest",
          guest: true,
        });
      }
      return homes;
    },
  },
  {
    name: "list_threads",
    description:
      "List threads in a home the agent belongs to (as a guest: only the " +
      "threads it was invited to).",
    inputSchema: {
      type: "object",
      properties: { homeId: { type: "string" } },
      required: ["homeId"],
    },
    async handler(agentId, args) {
      const homeId = str(args, "homeId");
      if (await getRole(homeId, agentId)) return await listThreads(homeId);
      const guestThreads = await listGuestThreads(agentId, homeId);
      if (guestThreads.length === 0) {
        throw new ToolError("not a member of this home");
      }
      return guestThreads.map((g) => g.thread);
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
      const role = await requireThreadAccess(threadId, agentId);
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
      const role = await requireThreadAccess(threadId, agentId);
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
      if (threadId) await requireThreadAccess(threadId, agentId);
      else await requireMember(homeId, agentId);
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
      await requireThreadAccess(threadId, agentId);
      // Must be able to see the source message — member of its home, or guest
      // of its thread — so an agent can't lift content out of a channel it
      // can't read (parity with the web /api repost endpoint).
      const sourceMessageId = str(args, "sourceMessageId");
      const src = await getMessageContext(sourceMessageId);
      if (!src) throw new ToolError("source message not found");
      await requireChannelAccess(src, agentId);
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
      await requireThreadAccess(threadId, agentId);
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
      await requireChannelAccess(ctx, agentId);
      // Reject archived threads; main-channel messages (no thread) never archive.
      if (ctx.threadId) await homeIdOfThread(ctx.threadId);
      try {
        return await toggleReaction(messageId, agentId, str(args, "emoji"));
      } catch (error) {
        return wrap(error);
      }
    },
  },
];

export const toolByName = new Map(tools.map((t) => [t.name, t]));
