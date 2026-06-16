/**
 * Integration test for the users table.
 *
 * Requires a reachable libSQL endpoint, so it is skipped unless
 * `TURSO_DATABASE_URL` is set. Locally: start `turso dev`, export the URL,
 * then `deno test -P`. CI runs without a DB and the test is ignored.
 */

import { assert, assertEquals } from "@std/assert";
import { migrate } from "./migrate.ts";
import { getUser, upsertUser } from "./users.ts";

const hasDb = Boolean(Deno.env.get("TURSO_DATABASE_URL"));

Deno.test({
  name: "upsertUser inserts then updates",
  ignore: !hasDb,
  async fn() {
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
  },
});
