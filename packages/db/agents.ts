/**
 * Agent identities + API tokens.
 *
 * An agent is a `users` row with `is_agent = 1`, owned by a human. It
 * authenticates to the MCP server with a bearer token; only the token's
 * SHA-256 hash is stored, and the plaintext is shown to the owner once at
 * creation. Per-home role is via `memberships`, like any user.
 */

import { monotonicUlid } from "@std/ulid";
import { db } from "./client.ts";
import { getUser, upsertUser } from "./users.ts";
import { HomeError } from "./homes.ts";

export interface Agent {
  id: string;
  displayName: string;
  createdAt: string;
}

/** Max agents a single human may own. */
export const MAX_AGENTS_PER_OWNER = 20;

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newToken(): string {
  const hex = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
  return `hpa_${hex}`;
}

/**
 * Create an agent owned by `ownerId`. Returns the agent and its plaintext
 * token (shown once — only the hash is stored).
 */
export async function createAgent(
  input: { ownerId: string; displayName: string },
): Promise<{ agent: Agent; token: string }> {
  const displayName = input.displayName.trim();
  if (!displayName) throw new HomeError("displayName is required");

  if ((await listAgentsByOwner(input.ownerId)).length >= MAX_AGENTS_PER_OWNER) {
    throw new HomeError(
      `エージェントは1人につき${MAX_AGENTS_PER_OWNER}個までです`,
      409,
    );
  }

  const id = `agent_${monotonicUlid()}`;
  await upsertUser({ id, displayName, isAgent: true });

  const token = newToken();
  await (await db()).execute({
    sql: "INSERT INTO agents (agent_id, owner_id, token_hash) VALUES (?, ?, ?)",
    args: [id, input.ownerId, await sha256hex(token)],
  });

  const user = await getUser(id);
  if (!user) throw new Error("createAgent failed to read back");
  return {
    agent: { id, displayName: user.displayName, createdAt: user.createdAt },
    token,
  };
}

/** Agents owned by a user, oldest first. */
export async function listAgentsByOwner(ownerId: string): Promise<Agent[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT a.agent_id, a.created_at, u.display_name FROM agents a " +
      "JOIN users u ON u.id = a.agent_id WHERE a.owner_id = ? " +
      "ORDER BY a.created_at",
    args: [ownerId],
  });
  return rows.map((r) => ({
    id: String(r.agent_id),
    displayName: String(r.display_name),
    createdAt: String(r.created_at),
  }));
}

/** Resolve a bearer token to its agent's user id, or `null`. */
export async function getAgentIdByToken(token: string): Promise<string | null> {
  if (!token.startsWith("hpa_")) return null;
  const { rows } = await (await db()).execute({
    sql: "SELECT agent_id FROM agents WHERE token_hash = ?",
    args: [await sha256hex(token)],
  });
  return rows[0] ? String(rows[0].agent_id) : null;
}

/**
 * Revoke an agent (owner only): drop its token and remove it from every home
 * so it can neither authenticate nor linger as a member. The `users` row is
 * kept so its past messages keep their author. Returns whether anything was
 * revoked.
 */
export async function deleteAgent(
  ownerId: string,
  agentId: string,
): Promise<boolean> {
  const client = await db();
  // Only the owner may revoke; check first so we don't strip memberships off
  // an agent we don't own.
  const { rows } = await client.execute({
    sql: "SELECT 1 FROM agents WHERE agent_id = ? AND owner_id = ?",
    args: [agentId, ownerId],
  });
  if (rows.length === 0) return false;

  await client.batch([
    {
      sql: "DELETE FROM agents WHERE agent_id = ? AND owner_id = ?",
      args: [agentId, ownerId],
    },
    {
      sql: "DELETE FROM memberships WHERE user_id = ?",
      args: [agentId],
    },
  ], "write");
  return true;
}
