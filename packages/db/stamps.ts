/**
 * Stamps (stickers) — standalone image posts, distinct from emoji reactions.
 *
 * A stamp's image lives in storage.kbn.one; this table stores its object key
 * (`storage_key`) plus a label used as alt text. Each user has a library
 * (`user_stamps`, max {@link MAX_LIBRARY_STAMPS}) with LRU eviction: using a
 * stamp updates `last_used_at`, and using someone else's stamp auto-adds it to
 * your library, pushing out the least-recently-used entry when full.
 *
 * Sharing model: every stamp owned by a member of a home is visible/usable by
 * that home's members. Removing a stamp from a library keeps the `stamps` row
 * (posted messages still reference it).
 */

import { monotonicUlid } from "@std/ulid";
import { db } from "./client.ts";
import { HomeError } from "./homes.ts";

/** Max stamps in a user's library; using more evicts the LRU entry. */
export const MAX_LIBRARY_STAMPS = 20;
export const MAX_STAMP_LABEL = 100;
const MAX_STORAGE_KEY = 512;

export interface Stamp {
  id: string;
  ownerId: string;
  /** Alt text; also the posted message's body (notifications show it). */
  label: string;
  /** storage.kbn.one object key (`POST /upload` response). */
  storageKey: string;
  contentType: string;
  createdAt: string;
}

/** A stamp in a user's library, ordered by recency of use. */
export interface LibraryStamp extends Stamp {
  addedAt: string;
  lastUsedAt: string;
}

/** A stamp visible in a home, tagged with whether the viewer owns it. */
export interface HomeStamp extends Stamp {
  inLibrary: boolean;
}

// `datetime('now')` is second-granular; use millisecond precision so rapid
// consecutive uses still order correctly for LRU.
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f','now')";

function rowToStamp(row: Record<string, unknown>): Stamp {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    label: String(row.label),
    storageKey: String(row.storage_key),
    contentType: String(row.content_type ?? ""),
    createdAt: String(row.created_at),
  };
}

/**
 * Register a stamp (owned by `ownerId`) and add it to the owner's library.
 * The image must already be uploaded to storage.kbn.one; `storageKey` is the
 * object key its upload API returned.
 */
export async function createStamp(
  input: {
    ownerId: string;
    label?: string;
    storageKey: string;
    contentType?: string;
  },
): Promise<Stamp> {
  const storageKey = input.storageKey.trim();
  if (!storageKey) throw new HomeError("storageKey is required");
  if (storageKey.length > MAX_STORAGE_KEY) {
    throw new HomeError("storageKey too long");
  }
  const label = (input.label ?? "").trim().slice(0, MAX_STAMP_LABEL) ||
    "スタンプ";
  const contentType = (input.contentType ?? "").trim();
  if (contentType && !contentType.startsWith("image/")) {
    throw new HomeError("スタンプは画像のみ登録できます");
  }

  const id = monotonicUlid();
  await (await db()).execute({
    sql:
      "INSERT INTO stamps (id, owner_id, label, storage_key, content_type) " +
      "VALUES (?, ?, ?, ?, ?)",
    args: [id, input.ownerId, label, storageKey, contentType],
  });
  await touchStamp(input.ownerId, id);
  const stamp = await getStamp(id);
  if (!stamp) throw new Error(`createStamp failed to read back ${id}`);
  return stamp;
}

export async function getStamp(id: string): Promise<Stamp | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM stamps WHERE id = ?",
    args: [id],
  });
  return rows[0] ? rowToStamp(rows[0]) : null;
}

/** The user's library, most recently used first (the last entry is next out). */
export async function listLibrary(userId: string): Promise<LibraryStamp[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT s.*, us.added_at, us.last_used_at FROM user_stamps us " +
      "JOIN stamps s ON s.id = us.stamp_id WHERE us.user_id = ? " +
      "ORDER BY us.last_used_at DESC, us.added_at DESC, s.id DESC",
    args: [userId],
  });
  return rows.map((row) => ({
    ...rowToStamp(row),
    addedAt: String(row.added_at),
    lastUsedAt: String(row.last_used_at),
  }));
}

/**
 * Every stamp owned by a current member of the home (the sharing model),
 * newest first, tagged with whether it is already in `viewerId`'s library.
 */
export async function listHomeStamps(
  homeId: string,
  viewerId: string,
): Promise<HomeStamp[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT s.*, " +
      "EXISTS(SELECT 1 FROM user_stamps us " +
      "WHERE us.user_id = ? AND us.stamp_id = s.id) AS in_library " +
      "FROM stamps s JOIN memberships m ON m.user_id = s.owner_id " +
      "WHERE m.home_id = ? ORDER BY s.created_at DESC, s.id DESC",
    args: [viewerId, homeId],
  });
  return rows.map((row) => ({
    ...rowToStamp(row),
    inLibrary: Number(row.in_library) === 1,
  }));
}

/** Remove a stamp from the user's library (the stamp itself remains). */
export async function removeFromLibrary(
  userId: string,
  stampId: string,
): Promise<void> {
  await (await db()).execute({
    sql: "DELETE FROM user_stamps WHERE user_id = ? AND stamp_id = ?",
    args: [userId, stampId],
  });
}

/**
 * Whether `userId` may post `stampId` into `homeId`: it is in their library,
 * or its owner is a member of that home (home sharing).
 */
export async function canUseStamp(
  stampId: string,
  userId: string,
  homeId: string,
): Promise<boolean> {
  const { rows } = await (await db()).execute({
    sql: "SELECT 1 FROM stamps s WHERE s.id = ? AND (" +
      "EXISTS(SELECT 1 FROM user_stamps us " +
      "WHERE us.user_id = ? AND us.stamp_id = s.id) OR " +
      "EXISTS(SELECT 1 FROM memberships m " +
      "WHERE m.home_id = ? AND m.user_id = s.owner_id))",
    args: [stampId, userId, homeId],
  });
  return rows.length > 0;
}

/**
 * Record a use of `stampId` by `userId`: add it to (or refresh it in) their
 * library and evict beyond {@link MAX_LIBRARY_STAMPS} by LRU.
 */
export async function touchStamp(
  userId: string,
  stampId: string,
): Promise<void> {
  const client = await db();
  await client.execute({
    sql: "INSERT INTO user_stamps (user_id, stamp_id, last_used_at) " +
      `VALUES (?, ?, ${NOW_MS}) ` +
      "ON CONFLICT (user_id, stamp_id) " +
      "DO UPDATE SET last_used_at = excluded.last_used_at",
    args: [userId, stampId],
  });
  await client.execute({
    sql: "DELETE FROM user_stamps WHERE user_id = ? AND stamp_id NOT IN (" +
      "SELECT stamp_id FROM user_stamps WHERE user_id = ? " +
      "ORDER BY last_used_at DESC, added_at DESC, stamp_id DESC LIMIT ?)",
    args: [userId, userId, MAX_LIBRARY_STAMPS],
  });
}
