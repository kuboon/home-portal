/**
 * Integration test for the users table, run against an in-memory libSQL DB
 * (`:memory:`) so it executes everywhere without a network or a `turso dev`
 * server. Set `TURSO_DATABASE_URL` to a real endpoint to run it against that
 * instead.
 */

import { assert, assertEquals } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { getUser, upsertUser } from "./users.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

Deno.test("upsertUser inserts then updates", async () => {
  resetClient();
  await migrate();

  const id = `test-${crypto.randomUUID()}`;
  const inserted = await upsertUser({ id, displayName: "Alice" });
  assertEquals(inserted.displayName, "Alice");
  assertEquals(inserted.isAgent, false);

  const updated = await upsertUser({
    id,
    displayName: "Alice Smith",
    isAgent: true,
  });
  assertEquals(updated.displayName, "Alice Smith");
  assertEquals(updated.isAgent, true);
  assertEquals(updated.createdAt, inserted.createdAt);

  const fetched = await getUser(id);
  assert(fetched);
  assertEquals(fetched.id, id);
});

Deno.test("getUser returns null for unknown id", async () => {
  await migrate();
  assertEquals(await getUser(`missing-${crypto.randomUUID()}`), null);
});
