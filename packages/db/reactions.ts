/**
 * Reactions on messages.
 *
 * A reaction is an emoji a user places on a message. A user may place up to
 * {@link MAX_REACTIONS_PER_MESSAGE} distinct emoji on a message. Reactions are
 * aggregated per message for display.
 */

import { db } from "./client.ts";
import { HomeError } from "./homes.ts";

export const MAX_REACTIONS_PER_MESSAGE = 5;

/** Aggregated reaction for a message: an emoji, its count, and viewer state. */
export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
}

/**
 * Toggle an emoji reaction for a user on a message. Returns whether it is now
 * present. Adding is capped at {@link MAX_REACTIONS_PER_MESSAGE} distinct emoji
 * per user.
 */
export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ added: boolean }> {
  const e = emoji.trim();
  if (!e) throw new HomeError("emoji is required");
  if (e.length > 32) throw new HomeError("emoji too long");

  const client = await db();
  const existing = await client.execute({
    sql:
      "SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
    args: [messageId, userId, e],
  });
  if (existing.rows.length > 0) {
    await client.execute({
      sql:
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
      args: [messageId, userId, e],
    });
    return { added: false };
  }

  // Enforce the per-user cap in the INSERT itself so two concurrent adds
  // can't both slip past a separate count check.
  const inserted = await client.execute({
    sql: "INSERT INTO reactions (message_id, user_id, emoji) " +
      "SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM reactions " +
      "WHERE message_id = ? AND user_id = ?) < ?",
    args: [messageId, userId, e, messageId, userId, MAX_REACTIONS_PER_MESSAGE],
  });
  if (inserted.rowsAffected === 0) {
    throw new HomeError(
      `リアクションは1投稿につき${MAX_REACTIONS_PER_MESSAGE}個までです`,
    );
  }
  return { added: true };
}

/** A conversation: a thread (`threadId`) or a home's main channel. */
export type Channel = { homeId: string; threadId?: string | null };

/** Aggregated reactions for every message in a channel, keyed by message id. */
export async function reactionsByMessage(
  channel: Channel,
  viewerId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const scope = channel.threadId
    ? { clause: "m.thread_id = ?", arg: channel.threadId }
    : { clause: "m.home_id = ? AND m.thread_id IS NULL", arg: channel.homeId };
  const { rows } = await (await db()).execute({
    sql: "SELECT r.message_id, r.emoji, COUNT(*) AS count, " +
      "MAX(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) AS mine " +
      "FROM reactions r JOIN messages m ON m.id = r.message_id " +
      `WHERE ${scope.clause} ` +
      "GROUP BY r.message_id, r.emoji ORDER BY count DESC, r.emoji",
    args: [viewerId, scope.arg],
  });
  const map = new Map<string, ReactionSummary[]>();
  for (const row of rows) {
    const id = String(row.message_id);
    const list = map.get(id) ?? [];
    list.push({
      emoji: String(row.emoji),
      count: Number(row.count),
      mine: Number(row.mine) === 1,
    });
    map.set(id, list);
  }
  return map;
}
