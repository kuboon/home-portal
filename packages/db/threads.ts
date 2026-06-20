/**
 * Thread + Message access.
 *
 * Threads live inside a Home; messages live inside a Thread. Membership/role
 * checks are the controller's job — these functions assume the caller is
 * already authorized. `listMessages` includes deleted messages as tombstones.
 */

import { monotonicUlid } from "@std/ulid";
import { db } from "./client.ts";
import { HomeError } from "./homes.ts";
import {
  type Channel,
  reactionsByMessage,
  type ReactionSummary,
} from "./reactions.ts";
import { joinedThreadIds, joinThread } from "./participants.ts";

/** Max message length, in characters. */
export const MAX_MESSAGE_LENGTH = 4000;

export interface Thread {
  id: string;
  homeId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  lastPostAt: string;
  archivedAt: string | null;
}

/** A thread plus whether the viewing user is currently joined to it. */
export interface ThreadForViewer extends Thread {
  joined: boolean;
}

/** Summary of the original message a repost references. */
export interface RepostOf {
  authorName: string;
  body: string;
  deleted: boolean;
}

export interface Message {
  id: string;
  homeId: string;
  /** The thread this belongs to, or `null` for a home's main channel. */
  threadId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Id of the original message this reposts, or `null`. */
  repostOf: string | null;
  /** The referenced original's summary when this is a repost. */
  repost: RepostOf | null;
  /** Aggregated reactions (populated by `listMessages`). */
  reactions: ReactionSummary[];
}

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: String(row.id),
    homeId: String(row.home_id),
    title: String(row.title),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    lastPostAt: String(row.last_post_at ?? row.created_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}

export async function createThread(
  input: { homeId: string; title: string; userId: string },
): Promise<Thread> {
  const title = input.title.trim();
  if (!title) throw new HomeError("title is required");

  const id = monotonicUlid();
  await (await db()).execute({
    sql: "INSERT INTO threads (id, home_id, title, created_by, last_post_at) " +
      "VALUES (?, ?, ?, ?, datetime('now'))",
    args: [id, input.homeId, title, input.userId],
  });
  // The creator is the first participant (empty thread: creator only).
  await joinThread(id, input.userId);
  const thread = await getThread(id);
  if (!thread) throw new Error(`createThread failed to read back ${id}`);
  return thread;
}

export async function getThread(id: string): Promise<Thread | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM threads WHERE id = ?",
    args: [id],
  });
  return rows[0] ? rowToThread(rows[0]) : null;
}

/** Days of inactivity (no posts) after which a thread auto-archives. */
export const ARCHIVE_AFTER_DAYS = 7;

/**
 * Archive threads in a home with no activity for {@link ARCHIVE_AFTER_DAYS}.
 * "Activity" is the latest message time, or the thread's creation time if it
 * has none. Run lazily before listing so archiving needs no cron.
 */
export async function archiveStaleThreads(homeId: string): Promise<void> {
  const client = await db();
  await client.execute({
    sql: "UPDATE threads SET archived_at = datetime('now') " +
      "WHERE home_id = ? AND archived_at IS NULL AND " +
      `COALESCE(last_post_at, created_at) < datetime('now', '-${ARCHIVE_AFTER_DAYS} days')`,
    args: [homeId],
  });
  // Archiving drops everyone out of the thread: no more notifications.
  await client.execute({
    sql: "UPDATE thread_participants SET state = 'left', " +
      "updated_at = datetime('now') WHERE state = 'joined' AND thread_id IN (" +
      "SELECT id FROM threads WHERE home_id = ? AND archived_at IS NOT NULL)",
    args: [homeId],
  });
}

/** Threads in a home, newest first. Auto-archives stale ones first. */
export async function listThreads(homeId: string): Promise<Thread[]> {
  await archiveStaleThreads(homeId);
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM threads WHERE home_id = ? ORDER BY created_at DESC",
    args: [homeId],
  });
  return rows.map(rowToThread);
}

/** Threads in a home tagged with whether `viewerId` is joined to each. */
export async function listThreadsForViewer(
  homeId: string,
  viewerId: string,
): Promise<ThreadForViewer[]> {
  const [threads, joined] = await Promise.all([
    listThreads(homeId),
    joinedThreadIds(homeId, viewerId),
  ]);
  return threads.map((t) => ({ ...t, joined: joined.has(t.id) }));
}

/** Mark a thread active now and ensure `userId` is a joined participant. */
async function touchThread(threadId: string, userId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE threads SET last_post_at = datetime('now') WHERE id = ?",
    args: [threadId],
  });
  await joinThread(threadId, userId);
}

/** Throw if the thread is archived (read-only) or missing. */
async function assertWritable(threadId: string): Promise<void> {
  const thread = await getThread(threadId);
  if (!thread) throw new HomeError("thread not found", 404);
  if (thread.archivedAt) {
    throw new HomeError("スレッドはアーカイブ済みです", 409);
  }
}

export async function postMessage(
  input: {
    homeId: string;
    /** Omit (or `null`) to post to the home's main channel. */
    threadId?: string | null;
    authorId: string;
    body: string;
  },
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new HomeError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  if (input.threadId) await assertWritable(input.threadId);

  const id = monotonicUlid();
  await (await db()).execute({
    sql: "INSERT INTO messages (id, home_id, thread_id, author_id, body) " +
      "VALUES (?, ?, ?, ?, ?)",
    args: [id, input.homeId, input.threadId ?? null, input.authorId, body],
  });
  // Posting into a thread joins (or re-joins) the author and keeps it active.
  if (input.threadId) await touchThread(input.threadId, input.authorId);
  const message = await getMessage(id);
  if (!message) throw new Error(`postMessage failed to read back ${id}`);
  return message;
}

// Shared SELECT: message + author, plus the referenced original (for reposts).
const MESSAGE_SELECT = "SELECT m.*, u.display_name, " +
  "o.body AS r_body, o.deleted_at AS r_deleted, ou.display_name AS r_author " +
  "FROM messages m " +
  "JOIN users u ON u.id = m.author_id " +
  "LEFT JOIN messages o ON o.id = m.repost_of " +
  "LEFT JOIN users ou ON ou.id = o.author_id";

async function getMessage(id: string): Promise<Message | null> {
  const { rows } = await (await db()).execute({
    sql: `${MESSAGE_SELECT} WHERE m.id = ?`,
    args: [id],
  });
  return rows[0] ? rowToMessage(rows[0]) : null;
}

function rowToMessage(row: Record<string, unknown>): Message {
  const deleted = row.deleted_at != null;
  const repostOf = row.repost_of == null ? null : String(row.repost_of);
  let repost: RepostOf | null = null;
  if (repostOf && row.r_author != null) {
    const rDeleted = row.r_deleted != null;
    repost = {
      authorName: String(row.r_author),
      body: rDeleted ? "" : String(row.r_body),
      deleted: rDeleted,
    };
  }
  return {
    id: String(row.id),
    homeId: String(row.home_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    authorId: String(row.author_id),
    authorName: String(row.display_name),
    // Deleted messages keep a tombstone (the row) but not their content.
    body: deleted ? "" : String(row.body),
    createdAt: String(row.created_at),
    editedAt: row.edited_at == null ? null : String(row.edited_at),
    deleted,
    repostOf,
    repost,
    reactions: [],
  };
}

/**
 * Messages in a channel (a thread, or a home's main channel), oldest first.
 * Deleted ones remain as tombstones. Reactions are attached for `viewerId`.
 */
async function listChannelMessages(
  channel: Channel,
  viewerId: string,
): Promise<Message[]> {
  const scope = channel.threadId
    ? { clause: "m.thread_id = ?", arg: channel.threadId }
    : { clause: "m.home_id = ? AND m.thread_id IS NULL", arg: channel.homeId };
  const { rows } = await (await db()).execute({
    sql: `${MESSAGE_SELECT} WHERE ${scope.clause} ORDER BY m.created_at`,
    args: [scope.arg],
  });
  const messages = rows.map(rowToMessage);
  const reactions = await reactionsByMessage(channel, viewerId);
  for (const m of messages) m.reactions = reactions.get(m.id) ?? [];
  return messages;
}

/** Messages in a thread, oldest first. */
export function listMessages(
  threadId: string,
  viewerId = "",
): Promise<Message[]> {
  return listChannelMessages({ homeId: "", threadId }, viewerId);
}

/** Messages in a home's main channel (no thread), oldest first. */
export function listMainMessages(
  homeId: string,
  viewerId = "",
): Promise<Message[]> {
  return listChannelMessages({ homeId, threadId: null }, viewerId);
}

/**
 * Repost (pick up) a message into a thread, with an optional comment (`body`).
 * Link flattening: a repost always references the ORIGINAL, so reposting a
 * repost copies its `repost_of` rather than pointing at the repost.
 */
export async function repostMessage(
  input: {
    homeId: string;
    /** Omit (or `null`) to repost into the home's main channel. */
    threadId?: string | null;
    authorId: string;
    sourceMessageId: string;
    body?: string;
  },
): Promise<Message> {
  const source = await getMessage(input.sourceMessageId);
  if (!source) throw new HomeError("source message not found", 404);
  if (input.threadId) await assertWritable(input.threadId);
  const original = source.repostOf ?? source.id;

  const id = monotonicUlid();
  const body = (input.body ?? "").trim();
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  await (await db()).execute({
    sql:
      "INSERT INTO messages (id, home_id, thread_id, author_id, body, repost_of) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    args: [
      id,
      input.homeId,
      input.threadId ?? null,
      input.authorId,
      body,
      original,
    ],
  });
  if (input.threadId) await touchThread(input.threadId, input.authorId);
  const message = await getMessage(id);
  if (!message) throw new Error(`repostMessage failed to read back ${id}`);
  return message;
}

/** Minimal message info for authorization (who/where), or `null`. */
export async function getMessageContext(
  messageId: string,
): Promise<
  { threadId: string | null; homeId: string; authorId: string } | null
> {
  const { rows } = await (await db()).execute({
    sql: "SELECT thread_id, home_id, author_id FROM messages WHERE id = ?",
    args: [messageId],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    threadId: row.thread_id == null ? null : String(row.thread_id),
    homeId: String(row.home_id),
    authorId: String(row.author_id),
  };
}

/** Edit a message's body in place and stamp `edited_at`. Author only. */
export async function editMessage(
  input: { messageId: string; authorId: string; body: string },
): Promise<Message> {
  const body = input.body.trim();
  if (!body) throw new HomeError("message body is required");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new HomeError(`message too long (max ${MAX_MESSAGE_LENGTH})`);
  }
  const ctx = await getMessageContext(input.messageId);
  if (ctx?.threadId) await assertWritable(ctx.threadId);
  const result = await (await db()).execute({
    sql: "UPDATE messages SET body = ?, edited_at = datetime('now') " +
      "WHERE id = ? AND author_id = ? AND deleted_at IS NULL",
    args: [body, input.messageId, input.authorId],
  });
  if (result.rowsAffected === 0) {
    throw new HomeError("message not found or not editable", 404);
  }
  const message = await getMessage(input.messageId);
  if (!message) throw new Error("editMessage failed to read back");
  return message;
}

/** Soft-delete a message: clear its body, leave a tombstone. Idempotent. */
export async function deleteMessage(messageId: string): Promise<void> {
  const ctx = await getMessageContext(messageId);
  if (ctx?.threadId) await assertWritable(ctx.threadId);
  await (await db()).execute({
    sql: "UPDATE messages SET deleted_at = datetime('now'), body = '' " +
      "WHERE id = ? AND deleted_at IS NULL",
    args: [messageId],
  });
}
