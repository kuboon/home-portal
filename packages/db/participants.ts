/**
 * Thread participation (the design's `ThreadParticipant`).
 *
 * The `joined` set is the source of truth for "who is in this thread": it is
 * the notification audience and drives the sidebar's joined/not-joined groups.
 * The main channel (a post with no thread) is everyone, so it is never tracked
 * here.
 *
 * Joining is idempotent and also un-leaves: posting or reacting in a thread
 * brings a `left` participant back to `joined`.
 */

import { db } from "./client.ts";

export type ParticipantState = "joined" | "left";

/** Join (or re-join) `userId` to a thread. Idempotent. */
export async function joinThread(
  threadId: string,
  userId: string,
): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO thread_participants (thread_id, user_id, state) " +
      "VALUES (?, ?, 'joined') " +
      "ON CONFLICT (thread_id, user_id) DO UPDATE SET " +
      "state = 'joined', updated_at = datetime('now')",
    args: [threadId, userId],
  });
}

/** Join several users at once (initial participants on thread creation/pickup). */
export async function joinThreadMany(
  threadId: string,
  userIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const client = await db();
  await client.batch(
    ids.map((userId) => ({
      sql: "INSERT INTO thread_participants (thread_id, user_id, state) " +
        "VALUES (?, ?, 'joined') " +
        "ON CONFLICT (thread_id, user_id) DO UPDATE SET " +
        "state = 'joined', updated_at = datetime('now')",
      args: [threadId, userId],
    })),
    "write",
  );
}

/** Explicitly leave a thread (stops notifications until the user returns). */
export async function leaveThread(
  threadId: string,
  userId: string,
): Promise<void> {
  await (await db()).execute({
    sql: "INSERT INTO thread_participants (thread_id, user_id, state) " +
      "VALUES (?, ?, 'left') " +
      "ON CONFLICT (thread_id, user_id) DO UPDATE SET " +
      "state = 'left', updated_at = datetime('now')",
    args: [threadId, userId],
  });
}

/** Set every joined participant of a thread to `left` (used on archive). */
export async function leaveAllParticipants(threadId: string): Promise<void> {
  await (await db()).execute({
    sql: "UPDATE thread_participants SET state = 'left', " +
      "updated_at = datetime('now') WHERE thread_id = ? AND state = 'joined'",
    args: [threadId],
  });
}

/** The user ids currently `joined` to a thread (the notification audience). */
export async function joinedUserIds(threadId: string): Promise<string[]> {
  const { rows } = await (await db()).execute({
    sql:
      "SELECT user_id FROM thread_participants WHERE thread_id = ? AND state = 'joined'",
    args: [threadId],
  });
  return rows.map((r) => String(r.user_id));
}

/** The thread ids in a home the user is currently `joined` to. */
export async function joinedThreadIds(
  homeId: string,
  userId: string,
): Promise<Set<string>> {
  const { rows } = await (await db()).execute({
    sql: "SELECT tp.thread_id FROM thread_participants tp " +
      "JOIN threads t ON t.id = tp.thread_id " +
      "WHERE t.home_id = ? AND tp.user_id = ? AND tp.state = 'joined'",
    args: [homeId, userId],
  });
  return new Set(rows.map((r) => String(r.thread_id)));
}
