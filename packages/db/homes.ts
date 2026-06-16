/**
 * Home + membership access.
 *
 * A Home is a small group capped at {@link MAX_MEMBERS} members. Roles are
 * `admin` | `member`; the creator is the first admin. All mutations that
 * change membership go through here so the member cap and the "a home always
 * keeps at least one admin" invariant are enforced in one place.
 */

import { monotonicUlid } from "@std/ulid";
import { db } from "./client.ts";
import { getUser } from "./users.ts";

export const MAX_MEMBERS = 40;

export type Role = "admin" | "member";

export interface Home {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A home together with the viewing user's role in it. */
export interface HomeWithRole extends Home {
  role: Role;
}

export interface Member {
  userId: string;
  displayName: string;
  isAgent: boolean;
  role: Role;
  createdAt: string;
}

/** Raised for caller-fixable problems (bad input, cap reached, last admin). */
export class HomeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "HomeError";
  }
}

function rowToHome(row: Record<string, unknown>): Home {
  return {
    id: String(row.id),
    name: String(row.name),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Create a home and make `userId` its first admin. */
export async function createHome(
  input: { name: string; userId: string },
): Promise<Home> {
  const name = input.name.trim();
  if (!name) throw new HomeError("name is required");

  const id = monotonicUlid();
  const client = await db();
  await client.batch([
    {
      sql: "INSERT INTO homes (id, name, created_by) VALUES (?, ?, ?)",
      args: [id, name, input.userId],
    },
    {
      sql:
        "INSERT INTO memberships (home_id, user_id, role) VALUES (?, ?, 'admin')",
      args: [id, input.userId],
    },
  ], "write");

  const home = await getHome(id);
  if (!home) throw new Error(`createHome failed to read back ${id}`);
  return home;
}

export async function getHome(id: string): Promise<Home | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM homes WHERE id = ?",
    args: [id],
  });
  return rows[0] ? rowToHome(rows[0]) : null;
}

/** Homes the user belongs to, newest last, with the user's role in each. */
export async function listHomesForUser(
  userId: string,
): Promise<HomeWithRole[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT h.*, m.role FROM homes h " +
      "JOIN memberships m ON m.home_id = h.id " +
      "WHERE m.user_id = ? ORDER BY h.created_at",
    args: [userId],
  });
  return rows.map((r) => ({ ...rowToHome(r), role: r.role as Role }));
}

/** The user's role in a home, or `null` if they are not a member. */
export async function getRole(
  homeId: string,
  userId: string,
): Promise<Role | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT role FROM memberships WHERE home_id = ? AND user_id = ?",
    args: [homeId, userId],
  });
  return rows[0] ? (rows[0].role as Role) : null;
}

export async function listMembers(homeId: string): Promise<Member[]> {
  const { rows } = await (await db()).execute({
    sql: "SELECT m.user_id, m.role, m.created_at, u.display_name, u.is_agent " +
      "FROM memberships m JOIN users u ON u.id = m.user_id " +
      "WHERE m.home_id = ? ORDER BY m.created_at",
    args: [homeId],
  });
  return rows.map((r) => ({
    userId: String(r.user_id),
    displayName: String(r.display_name),
    isAgent: Number(r.is_agent) === 1,
    role: r.role as Role,
    createdAt: String(r.created_at),
  }));
}

async function countMembers(homeId: string): Promise<number> {
  const { rows } = await (await db()).execute({
    sql: "SELECT COUNT(*) AS n FROM memberships WHERE home_id = ?",
    args: [homeId],
  });
  return Number(rows[0].n);
}

async function countAdmins(homeId: string): Promise<number> {
  const { rows } = await (await db()).execute({
    sql:
      "SELECT COUNT(*) AS n FROM memberships WHERE home_id = ? AND role = 'admin'",
    args: [homeId],
  });
  return Number(rows[0].n);
}

/** Add an existing user to a home. Enforces the member cap. */
export async function addMember(
  homeId: string,
  userId: string,
  role: Role = "member",
): Promise<Member> {
  if (!(await getUser(userId))) {
    throw new HomeError(`unknown user: ${userId}`, 404);
  }
  if (await getRole(homeId, userId)) {
    throw new HomeError("user is already a member", 409);
  }
  if (await countMembers(homeId) >= MAX_MEMBERS) {
    throw new HomeError(`home is full (max ${MAX_MEMBERS})`, 409);
  }
  await (await db()).execute({
    sql: "INSERT INTO memberships (home_id, user_id, role) VALUES (?, ?, ?)",
    args: [homeId, userId, role],
  });
  const member = (await listMembers(homeId)).find((m) => m.userId === userId);
  if (!member) throw new Error("addMember failed to read back");
  return member;
}

/** Change a member's role, keeping at least one admin. */
export async function setMemberRole(
  homeId: string,
  userId: string,
  role: Role,
): Promise<void> {
  const current = await getRole(homeId, userId);
  if (!current) throw new HomeError("not a member", 404);
  if (
    current === "admin" && role !== "admin" && await countAdmins(homeId) <= 1
  ) {
    throw new HomeError("cannot demote the last admin");
  }
  await (await db()).execute({
    sql: "UPDATE memberships SET role = ? WHERE home_id = ? AND user_id = ?",
    args: [role, homeId, userId],
  });
}

/** Remove a member, keeping at least one admin. */
export async function removeMember(
  homeId: string,
  userId: string,
): Promise<void> {
  const current = await getRole(homeId, userId);
  if (!current) throw new HomeError("not a member", 404);
  if (current === "admin" && await countAdmins(homeId) <= 1) {
    throw new HomeError("cannot remove the last admin");
  }
  await (await db()).execute({
    sql: "DELETE FROM memberships WHERE home_id = ? AND user_id = ?",
    args: [homeId, userId],
  });
}
