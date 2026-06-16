/**
 * Reactions (stamps) on messages.
 *
 * A user may place up to {@link MAX_STAMPS_PER_MESSAGE} distinct stamps on a
 * message. Reactions are aggregated per message for display.
 */

import { db } from "./client.ts";
import { HomeError } from "./homes.ts";

export const MAX_STAMPS_PER_MESSAGE = 5;

/** Aggregated reaction for a message: a stamp, its count, and viewer state. */
export interface ReactionSummary {
  stamp: string;
  count: number;
  mine: boolean;
}

async function userStampCount(
  messageId: string,
  userId: string,
): Promise<number> {
  const { rows } = await (await db()).execute({
    sql:
      "SELECT COUNT(*) AS n FROM reactions WHERE message_id = ? AND user_id = ?",
    args: [messageId, userId],
  });
  return Number(rows[0].n);
}

/**
 * Toggle a stamp for a user on a message. Returns whether it is now present.
 * Adding is capped at {@link MAX_STAMPS_PER_MESSAGE} distinct stamps per user.
 */
export async function toggleReaction(
  messageId: string,
  userId: string,
  stamp: string,
): Promise<{ added: boolean }> {
  const s = stamp.trim();
  if (!s) throw new HomeError("stamp is required");
  if (s.length > 32) throw new HomeError("stamp too long");

  const client = await db();
  const existing = await client.execute({
    sql:
      "SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND stamp = ?",
    args: [messageId, userId, s],
  });
  if (existing.rows.length > 0) {
    await client.execute({
      sql:
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND stamp = ?",
      args: [messageId, userId, s],
    });
    return { added: false };
  }

  if (await userStampCount(messageId, userId) >= MAX_STAMPS_PER_MESSAGE) {
    throw new HomeError(
      `リアクションは1投稿につき${MAX_STAMPS_PER_MESSAGE}個までです`,
    );
  }
  await client.execute({
    sql: "INSERT INTO reactions (message_id, user_id, stamp) VALUES (?, ?, ?)",
    args: [messageId, userId, s],
  });
  return { added: true };
}

/** Aggregated reactions for every message in a thread, keyed by message id. */
export async function reactionsByMessage(
  threadId: string,
  viewerId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const { rows } = await (await db()).execute({
    sql: "SELECT r.message_id, r.stamp, COUNT(*) AS count, " +
      "MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) AS mine " +
      "FROM reactions r JOIN messages m ON m.id = r.message_id " +
      "WHERE m.thread_id = ? " +
      "GROUP BY r.message_id, r.stamp ORDER BY count DESC, r.stamp",
    args: [viewerId, threadId],
  });
  const map = new Map<string, ReactionSummary[]>();
  for (const row of rows) {
    const id = String(row.message_id);
    const list = map.get(id) ?? [];
    list.push({
      stamp: String(row.stamp),
      count: Number(row.count),
      mine: Number(row.mine) === 1,
    });
    map.set(id, list);
  }
  return map;
}
