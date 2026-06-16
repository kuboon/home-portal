/**
 * Home + membership tests against an in-memory libSQL DB (`:memory:`).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import {
  addMember,
  createHome,
  getRole,
  HomeError,
  listHomesForUser,
  listMembers,
  removeMember,
  setMemberRole,
} from "./homes.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function freshDb() {
  resetClient();
  await migrate();
}

Deno.test("createHome makes the creator an admin member", async () => {
  await freshDb();
  await upsertUser({ id: "alice", displayName: "Alice" });

  const home = await createHome({ name: "Family", userId: "alice" });
  assertEquals(home.name, "Family");
  assertEquals(home.createdBy, "alice");

  assertEquals(await getRole(home.id, "alice"), "admin");
  const homes = await listHomesForUser("alice");
  assertEquals(homes.length, 1);
  assertEquals(homes[0].role, "admin");
});

Deno.test("addMember adds an existing user; unknown user rejected", async () => {
  await freshDb();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  const home = await createHome({ name: "Family", userId: "alice" });

  const bob = await addMember(home.id, "bob");
  assertEquals(bob.role, "member");
  assertEquals((await listMembers(home.id)).length, 2);

  await assertRejects(
    () => addMember(home.id, "ghost"),
    HomeError,
    "unknown user",
  );
  await assertRejects(
    () => addMember(home.id, "bob"),
    HomeError,
    "already a member",
  );
});

Deno.test("last admin cannot be demoted or removed", async () => {
  await freshDb();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  const home = await createHome({ name: "Family", userId: "alice" });
  await addMember(home.id, "bob");

  await assertRejects(
    () => setMemberRole(home.id, "alice", "member"),
    HomeError,
    "last admin",
  );
  await assertRejects(
    () => removeMember(home.id, "alice"),
    HomeError,
    "last admin",
  );

  // Promote bob, then alice can be demoted.
  await setMemberRole(home.id, "bob", "admin");
  await setMemberRole(home.id, "alice", "member");
  assertEquals(await getRole(home.id, "alice"), "member");

  await removeMember(home.id, "alice");
  assert(!(await getRole(home.id, "alice")));
});
