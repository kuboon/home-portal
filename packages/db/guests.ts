/**
 * Thread guests: users admitted to a single thread of a home they are not a
 * member of. A guest has member-equivalent powers inside that thread only
 * (read, post, react, edit/delete their own posts) and sees nothing else of
 * the home. Home admins invite and remove guests.
 *
 * {@link getThreadAccess} is the single thread-scoped authorization primitive:
 * membership first (admin/member), then the guest table.
 */

import { db } from "./client.ts";
import { getRole, HomeError, type Role } from "./homes.ts";
import { joinThread, leaveThread } from "./participants.ts";
import { getThread, rowToThread, type Thread } from "./threads.ts";
import { getUser } from "./users.ts";

/** A viewer's standing in a thread: a home role, or `guest`. */
export type ThreadRole = Role | "guest";

export interface ThreadAccess {
  homeId: string;
  thread: Thread;
  role: ThreadRole;
}

export interface Guest {
  userId: string;
  displayName: string;
  isAgent: boolean;
  invitedBy: string | null;
  createdAt: string;
}

export interface GuestThread {
  home: { id: string; name: string };
  thread: Thread;
}

export async function isGuest(
  threadId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await (await db()).execute({
    sql: "SELECT 1 FROM thread_guests WHERE thread_id = ? AND user_id = ?",
    args: [threadId, userId],
  });
  return rows.length > 0;
}

/**
 * The user's access to a thread: their home role if they are a member,
 * `guest` if admitted as a guest, otherwise `null` (also for a missing thread).
 */
export async function getThreadAccess(
  threadId: string,
  userId: string,
): Promise<ThreadAccess | null> {
  const thread = await getThread(threadId);
  if (!thread) return null;
  const role = await getRole(thread.homeId, userId);
  if (role) return { homeId: thread.homeId, thread, role };
  if (await isGuest(threadId, userId)) {
    return { homeId: thread.homeId, thread, role: "guest" };
  }
  return null;
}

/**
 * Admit `userId` as a guest of a thread and join them to it (notifications).
 * Rejects home members (409: they already have access). Idempotent for an
 * existing guest.
 */
export async function addGuest(
  threadId: string,
  userId: string,
  invitedBy: string | null,
): Promise<void> {
  const thread = await getThread(threadId);
  if (!thread) throw new HomeError("thread not found", 404);
  if (!(await getUser(userId))) {
    throw new HomeError(`unknown user: ${userId}`, 404);
  }
  if (await getRole(thread.homeId, userId)) {
    throw new HomeError("user is already a member", 409);
  }
  await (await db()).execute({
    sql: "INSERT INTO thread_guests (thread_id, user_id, invited_by) " +
      "VALUES (?, ?, ?) ON CONFLICT (thread_id, user_id) DO NOTHING",
    args: [threadId, userId, invitedBy],
  });
  await joinThread(threadId, userId);
}

/** Remove a guest from a thread (also stops their notifications). */
export async function removeGuest(
  threadId: string,
  userId: string,
): Promise<void> {
  if (!(await isGuest(threadId, userId))) {
    throw new HomeError("not a guest", 404);
  }
  await (await db()).execute({
    sql: "DELETE FROM thread_guests WHERE thread_id = ? AND user_id = ?",
    args: [threadId, userId],
  });
  await leaveThread(threadId, userId);
}

export async function listGuests(threadId: string): Promise<Guest[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT g.user_id, g.invited_by, g.created_at, u.display_name, " +
      "u.is_agent FROM thread_guests g JOIN users u ON u.id = g.user_id " +
      "WHERE g.thread_id = ? ORDER BY g.created_at",
    args: [threadId],
  });
  return rows.map((r) => ({
    userId: String(r.user_id),
    displayName: String(r.display_name),
    isAgent: Number(r.is_agent) === 1,
    invitedBy: r.invited_by == null ? null : String(r.invited_by),
    createdAt: String(r.created_at),
  }));
}

/** Threads the user is a guest of (optionally within one home), newest first. */
export async function listGuestThreads(
  userId: string,
  homeId?: string,
): Promise<GuestThread[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT t.*, h.name AS home_name FROM thread_guests g " +
      "JOIN threads t ON t.id = g.thread_id JOIN homes h ON h.id = t.home_id " +
      "WHERE g.user_id = ?" + (homeId ? " AND t.home_id = ?" : "") +
      " ORDER BY t.created_at DESC",
    args: homeId ? [userId, homeId] : [userId],
  });
  return rows.map((r) => ({
    home: { id: String(r.home_id), name: String(r.home_name) },
    thread: rowToThread(r),
  }));
}
