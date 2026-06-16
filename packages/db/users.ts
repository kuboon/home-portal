/**
 * `users` table access.
 *
 * Users originate from the id.kbn.one IdP: after a passkey sign-in the client
 * tells us its IdP `userId`, and we upsert a row here so the rest of the app
 * can reference a stable local identity. Agents are ordinary users with
 * `is_agent = 1`.
 */

import { db } from "./client.ts";

export interface User {
  id: string;
  displayName: string;
  isAgent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertUserInput {
  id: string;
  displayName: string;
  isAgent?: boolean;
}

/**
 * Insert a user, or update its `display_name`/`is_agent` if it already exists.
 * Returns the resulting row.
 */
export async function upsertUser(input: UpsertUserInput): Promise<User> {
  const isAgent = input.isAgent ? 1 : 0;
  await db().execute({
    sql: "INSERT INTO users (id, display_name, is_agent) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "display_name = excluded.display_name, " +
      "is_agent = excluded.is_agent, " +
      "updated_at = datetime('now')",
    args: [input.id, input.displayName, isAgent],
  });
  const user = await getUser(input.id);
  if (!user) throw new Error(`upsertUser failed to read back ${input.id}`);
  return user;
}

/** Fetch a user by id, or `null` if not found. */
export async function getUser(id: string): Promise<User | null> {
  const { rows } = await db().execute({
    sql: "SELECT id, display_name, is_agent, created_at, updated_at " +
      "FROM users WHERE id = ?",
    args: [id],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    isAgent: Number(row.is_agent) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
