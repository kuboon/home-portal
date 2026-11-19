/**
 * /api — DPoP-protected Thread + Message endpoints.
 *
 * Thread-scoped actions (read, post, react, repost into, edit/delete) need
 * thread access: membership in the thread's home, or being a guest of that
 * thread (`getThreadAccess`). Home-scoped actions (thread list/create, pickup,
 * the main channel) stay members only. The acting user is the `userId` bound
 * to the DPoP session.
 */

import { createController } from "@remix-run/fetch-router";

import {
  canUseStamp,
  createThread,
  editMessage,
  getHome,
  getMessageContext,
  getRole,
  getThread,
  getThreadAccess,
  hideMessage,
  HomeError,
  type ImageInput,
  leaveThread,
  listGuests,
  listGuestThreads,
  listMainMessages,
  listMessages,
  listThreadsForViewer,
  type Message,
  pickupIntoThread,
  postMessage,
  removeGuest,
  renameThread,
  repostMessage,
  toggleReaction,
  tombstoneMessage,
  touchStamp,
} from "@scope/db";
import { dpop, DpopSession } from "../../middleware/dpop.ts";
import { notifyNewMessage } from "../../notify.ts";
import {
  signalMainChannel,
  signalThread,
  watchMainChannel,
  watchThread,
} from "../../realtime.ts";
import { createThreadInvite, INVITE_TTL_MS } from "../../invites.ts";
import { checkPostLimit, checkRepostLimit } from "../../rate_limit.ts";
import { getRecentEmojis, pushRecentEmoji } from "../../recent_emojis.ts";
import { routes } from "../../routes.ts";

function currentUserId(session: DpopSession): string | null {
  const value = session.get("userId");
  return typeof value === "string" ? value : null;
}

const unauthorized = () =>
  Response.json({ error: "not signed in" }, { status: 401 });
const forbidden = () =>
  Response.json({ error: "not a member" }, { status: 403 });
const rateLimited = () =>
  Response.json({ error: "送信が速すぎます。少し待ってください。" }, {
    status: 429,
  });

function handleError(error: unknown): Response {
  if (error instanceof HomeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/**
 * The caller's role for a message's channel: thread access (member or guest)
 * for a thread post, home membership for a main-channel post.
 */
async function channelRole(
  ctx: { homeId: string; threadId: string | null },
  userId: string,
): Promise<string | null> {
  if (ctx.threadId) {
    return (await getThreadAccess(ctx.threadId, userId))?.role ?? null;
  }
  return await getRole(ctx.homeId, userId);
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

/** Bump the right realtime signal for a message's channel (thread or main). */
function signalChannel(ctx: { homeId: string; threadId: string | null }) {
  return ctx.threadId
    ? signalThread(ctx.threadId)
    : signalMainChannel(ctx.homeId);
}

/**
 * Post a text message, a stamp (`stampId`), or a message with an attached
 * image (`image`) into a channel. A stamp must be usable by the author in that
 * home (their library, or owned by a member — the sharing model); using one
 * refreshes/auto-adds it to the author's library (LRU). An image's bytes are
 * already in storage.kbn.one (browser upload); we only record the key.
 * Returns the message, or an error response.
 */
async function postToChannel(input: {
  homeId: string;
  threadId?: string | null;
  authorId: string;
  body?: string;
  stampId?: string;
  image?: ImageInput | null;
}): Promise<Message | Response> {
  if (input.stampId) {
    if (!(await canUseStamp(input.stampId, input.authorId, input.homeId))) {
      return Response.json({ error: "このスタンプは使えません" }, {
        status: 403,
      });
    }
  }
  const message = await postMessage({
    homeId: input.homeId,
    threadId: input.threadId,
    authorId: input.authorId,
    body: input.body ?? "",
    stampId: input.stampId,
    image: input.image,
  });
  if (input.stampId) await touchStamp(input.authorId, input.stampId);
  return message;
}

/** Extract a well-formed image attachment from an untrusted request body. */
function readImage(body: { image?: unknown }): ImageInput | undefined {
  const img = body.image;
  if (!img || typeof img !== "object") return undefined;
  const rec = img as Record<string, unknown>;
  if (typeof rec.storageKey !== "string") return undefined;
  return {
    storageKey: rec.storageKey,
    contentType: typeof rec.contentType === "string"
      ? rec.contentType
      : undefined,
    width: typeof rec.width === "number" ? rec.width : undefined,
    height: typeof rec.height === "number" ? rec.height : undefined,
    expiresAt: typeof rec.expiresAt === "string" ? rec.expiresAt : undefined,
  };
}

/** SSE comment interval; keeps proxies from closing an idle stream. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Wrap a realtime watch stream as an SSE response. Emits a `ready` ping, then
 * a `sync` ping on every change; the client re-fetches the channel's
 * messages. If the watch ends (e.g. the hub restarted on deploy) the response
 * ends too, so the client reconnects and re-syncs.
 */
function sseFromWatch(
  request: Request,
  watch: ReadableStream<unknown>,
): Response {
  const encoder = new TextEncoder();
  const reader = watch.getReader();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    reader.cancel().catch(() => {});
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch { /* already closed */ }
      };
      const close = () => {
        stop();
        try {
          controller.close();
        } catch { /* already closed */ }
      };
      send("event: ready\ndata: {}\n\n");
      heartbeat = setInterval(() => send(": hb\n\n"), SSE_HEARTBEAT_MS);
      request.signal.addEventListener("abort", close);

      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
            send("event: sync\ndata: {}\n\n");
          }
        } catch { /* hub or client gone */ }
        close();
      })();
    },
    cancel: stop,
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export const threadsController = createController(routes.threadsApi, {
  middleware: [dpop],
  actions: {
    async list(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      return Response.json({
        threads: await listThreadsForViewer(homeId, userId),
      });
    },

    async leave(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      await leaveThread(threadId, userId);
      return Response.json({ ok: true });
    },

    async access(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      const home = await getHome(access.homeId);
      if (!home) return notFound();
      return Response.json({
        role: access.role,
        home: { id: home.id, name: home.name, themeCss: home.themeCss },
        thread: access.thread,
        // A guest's sidebar: only the threads of this home they were let into.
        guestThreads: access.role === "guest"
          ? (await listGuestThreads(userId, access.homeId)).map((g) => g.thread)
          : [],
      });
    },

    async guestThreads(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ guestThreads: await listGuestThreads(userId) });
    },

    async guests(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) return notFound();
      if (!(await getRole(thread.homeId, userId))) return forbidden();
      return Response.json({ guests: await listGuests(threadId) });
    },

    async removeGuest(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId, userId: guestId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) return notFound();
      // A guest may leave on their own; otherwise a home admin removes them.
      if (
        guestId !== userId &&
        await getRole(thread.homeId, userId) !== "admin"
      ) {
        return Response.json({ error: "admin only" }, { status: 403 });
      }
      try {
        await removeGuest(threadId, guestId);
        await signalThread(threadId);
        return Response.json({ ok: true });
      } catch (error) {
        return handleError(error);
      }
    },

    async invite(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) return notFound();
      if (await getRole(thread.homeId, userId) !== "admin") {
        return Response.json({ error: "admin only" }, { status: 403 });
      }
      if (thread.archivedAt) {
        return Response.json({ error: "スレッドはアーカイブ済みです" }, {
          status: 409,
        });
      }
      const token = await createThreadInvite(thread.homeId, threadId, userId);
      return Response.json({ token, ttlMs: INVITE_TTL_MS }, { status: 201 });
    },

    async renameThread(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      const role = access.role;
      const body = await context.request.json() as { title?: string };
      try {
        const updated = await renameThread({
          threadId,
          title: body.title ?? "",
          userId,
          isAdmin: role === "admin",
        });
        await signalThread(threadId);
        return Response.json({ thread: updated });
      } catch (error) {
        return handleError(error);
      }
    },

    async create(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      const body = await context.request.json() as {
        title?: string;
        sourcePostIds?: string[];
      };
      const pickupIds = body.sourcePostIds ?? [];
      // Pickup-on-create consumes the pickup budget (separate from post limits).
      if (pickupIds.length > 0 && !(await checkRepostLimit(userId))) {
        return rateLimited();
      }
      try {
        const thread = await createThread({
          homeId,
          title: body.title ?? "",
          userId,
        });
        if (pickupIds.length > 0) {
          await pickupIntoThread({
            homeId,
            threadId: thread.id,
            sourcePostIds: pickupIds,
            authorId: userId,
          });
        }
        return Response.json({ thread }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async pickup(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const thread = await getThread(threadId);
      if (!thread) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!(await getRole(thread.homeId, userId))) return forbidden();
      const body = await context.request.json() as {
        sourcePostIds?: string[];
      };
      if (!body.sourcePostIds?.length) {
        return Response.json({ error: "sourcePostIds is required" }, {
          status: 400,
        });
      }
      if (!(await checkRepostLimit(userId))) return rateLimited();
      try {
        const messages = await pickupIntoThread({
          homeId: thread.homeId,
          threadId,
          sourcePostIds: body.sourcePostIds,
          authorId: userId,
        });
        await signalThread(threadId);
        return Response.json({ messages }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async mainMessages(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      const role = await getRole(homeId, userId);
      if (!role) return forbidden();
      return Response.json({
        messages: await listMainMessages(homeId, userId, role === "admin"),
      });
    },

    async mainPost(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      if (!(await checkPostLimit(userId))) return rateLimited();
      const body = await context.request.json() as {
        body?: string;
        stampId?: string;
        image?: unknown;
      };
      try {
        const message = await postToChannel({
          homeId,
          authorId: userId,
          body: body.body,
          stampId: body.stampId,
          image: readImage(body),
        });
        if (message instanceof Response) return message;
        await signalMainChannel(homeId);
        await notifyNewMessage({
          homeId,
          authorId: userId,
          body: message.body,
        });
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async mainRepost(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      const body = await context.request.json() as {
        sourceMessageId?: string;
        body?: string;
      };
      if (!body.sourceMessageId) {
        return Response.json({ error: "sourceMessageId is required" }, {
          status: 400,
        });
      }
      const src = await getMessageContext(body.sourceMessageId);
      if (!src) {
        return Response.json({ error: "source not found" }, { status: 404 });
      }
      if (!(await channelRole(src, userId))) {
        return Response.json({ error: "cannot access source" }, {
          status: 403,
        });
      }
      if (!(await checkRepostLimit(userId))) return rateLimited();
      try {
        const message = await repostMessage({
          homeId,
          authorId: userId,
          sourceMessageId: body.sourceMessageId,
          body: body.body,
        });
        await signalMainChannel(homeId);
        await notifyNewMessage({
          homeId,
          authorId: userId,
          body: message.body,
        });
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async mainStream(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { homeId } = context.params;
      if (!(await getRole(homeId, userId))) return forbidden();
      return sseFromWatch(
        context.request,
        await watchMainChannel(homeId),
      );
    },

    async messages(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      const role = access.role;
      return Response.json({
        messages: await listMessages(threadId, userId, role === "admin"),
      });
    },

    async post(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      const thread = access.thread;
      if (!(await checkPostLimit(userId))) return rateLimited();
      const body = await context.request.json() as {
        body?: string;
        stampId?: string;
        image?: unknown;
      };
      try {
        const message = await postToChannel({
          homeId: thread.homeId,
          threadId,
          authorId: userId,
          body: body.body,
          stampId: body.stampId,
          image: readImage(body),
        });
        if (message instanceof Response) return message;
        await signalThread(threadId);
        await notifyNewMessage({
          homeId: thread.homeId,
          threadId,
          authorId: userId,
          body: message.body,
        });
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async repost(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      const thread = access.thread;

      const body = await context.request.json() as {
        sourceMessageId?: string;
        body?: string;
      };
      if (!body.sourceMessageId) {
        return Response.json({ error: "sourceMessageId is required" }, {
          status: 400,
        });
      }
      // Must be able to see the source (member of its home, or guest of its
      // thread).
      const src = await getMessageContext(body.sourceMessageId);
      if (!src) {
        return Response.json({ error: "source not found" }, { status: 404 });
      }
      if (!(await channelRole(src, userId))) {
        return Response.json({ error: "cannot access source" }, {
          status: 403,
        });
      }
      if (!(await checkRepostLimit(userId))) return rateLimited();
      try {
        const message = await repostMessage({
          homeId: thread.homeId,
          threadId,
          authorId: userId,
          sourceMessageId: body.sourceMessageId,
          body: body.body,
        });
        await signalThread(threadId);
        await notifyNewMessage({
          homeId: thread.homeId,
          threadId,
          authorId: userId,
          body: message.body,
        });
        return Response.json({ message }, { status: 201 });
      } catch (error) {
        return handleError(error);
      }
    },

    async stream(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { threadId } = context.params;
      const access = await getThreadAccess(threadId, userId);
      if (!access) {
        return (await getThread(threadId)) ? forbidden() : notFound();
      }
      return sseFromWatch(context.request, await watchThread(threadId));
    },

    async editMessage(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { messageId } = context.params;
      const ctx = await getMessageContext(messageId);
      if (!ctx) return Response.json({ error: "not found" }, { status: 404 });
      if (ctx.authorId !== userId) {
        return Response.json({ error: "author only" }, { status: 403 });
      }
      // A removed guest (or ex-member) can no longer touch their old posts.
      if (!(await channelRole(ctx, userId))) return forbidden();
      const body = await context.request.json() as { body?: string };
      try {
        const message = await editMessage({
          messageId,
          authorId: userId,
          body: body.body ?? "",
        });
        await signalChannel(ctx);
        return Response.json({ message });
      } catch (error) {
        return handleError(error);
      }
    },

    async deleteMessage(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { messageId } = context.params;
      const ctx = await getMessageContext(messageId);
      if (!ctx) return Response.json({ error: "not found" }, { status: 404 });
      const role = await channelRole(ctx, userId);
      if (!role) return forbidden();
      // Author deletion (own post) destroys the body and leaves a tombstone;
      // admin moderation (another's post) hides it but keeps the body.
      if (ctx.authorId === userId) {
        await tombstoneMessage(messageId, userId);
      } else if (role === "admin") {
        await hideMessage(messageId);
      } else {
        return Response.json({ error: "author or admin only" }, {
          status: 403,
        });
      }
      await signalChannel(ctx);
      return Response.json({ ok: true });
    },

    async react(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      const { messageId } = context.params;
      const ctx = await getMessageContext(messageId);
      if (!ctx) return Response.json({ error: "not found" }, { status: 404 });
      if (!(await channelRole(ctx, userId))) return forbidden();
      // Main-channel messages (no thread) never archive.
      const thread = ctx.threadId ? await getThread(ctx.threadId) : null;
      if (thread?.archivedAt) {
        return Response.json({ error: "スレッドはアーカイブ済みです" }, {
          status: 409,
        });
      }
      const body = await context.request.json() as { emoji?: string };
      if (!body.emoji) {
        return Response.json({ error: "emoji is required" }, { status: 400 });
      }
      try {
        const result = await toggleReaction(messageId, userId, body.emoji);
        if (result.added) await pushRecentEmoji(userId, body.emoji);
        await signalChannel(ctx);
        return Response.json(result);
      } catch (error) {
        return handleError(error);
      }
    },

    async recentEmojis(context) {
      const userId = currentUserId(context.get(DpopSession));
      if (!userId) return unauthorized();
      return Response.json({ emojis: await getRecentEmojis(userId) });
    },
  },
});
