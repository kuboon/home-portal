/**
 * Thread participation tests against an in-memory libSQL DB (`:memory:`).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { createHome } from "./homes.ts";
import { createThread, listThreadsForViewer, postMessage } from "./threads.ts";
import { joinedUserIds, leaveThread } from "./participants.ts";
import { toggleReaction } from "./reactions.ts";
import { db } from "./client.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  const home = await createHome({ name: "H", userId: "alice" });
  return home;
}

Deno.test("creator is the initial participant; posting/reacting joins; leave/rejoin", async () => {
  const home = await setup();
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  assertEquals(await joinedUserIds(thread.id), ["alice"]);

  // Bob posts → joined.
  const msg = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    body: "hi",
  });
  assertEquals((await joinedUserIds(thread.id)).sort(), ["alice", "bob"]);

  // Bob leaves → no longer joined.
  await leaveThread(thread.id, "bob");
  assertFalse((await joinedUserIds(thread.id)).includes("bob"));

  // Bob reacts to a post in the thread → re-joined.
  await toggleReaction(msg.id, "bob", "👍");
  assert((await joinedUserIds(thread.id)).includes("bob"));
});

Deno.test("main-channel posts and reactions create no participants", async () => {
  const home = await setup();
  const msg = await postMessage({
    homeId: home.id,
    authorId: "alice",
    body: "main",
  });
  await toggleReaction(msg.id, "bob", "👍");
  const { rows } = await (await db()).execute(
    "SELECT COUNT(*) AS c FROM thread_participants",
  );
  assertEquals(Number(rows[0].c), 0);
});

Deno.test("listThreadsForViewer flags joined threads", async () => {
  const home = await setup();
  const a = await createThread({
    homeId: home.id,
    title: "a",
    userId: "alice",
  });
  const b = await createThread({ homeId: home.id, title: "b", userId: "bob" });

  const forAlice = await listThreadsForViewer(home.id, "alice");
  assertEquals(forAlice.find((t) => t.id === a.id)?.joined, true);
  assertEquals(forAlice.find((t) => t.id === b.id)?.joined, false);
});

Deno.test("archiving a stale thread leaves all participants", async () => {
  const home = await setup();
  const client = await db();
  await client.execute({
    sql: "INSERT INTO threads " +
      "(id, home_id, title, created_by, created_at, last_post_at) " +
      "VALUES ('old', ?, 'old', 'alice', datetime('now','-10 days'), " +
      "datetime('now','-10 days'))",
    args: [home.id],
  });
  await client.execute(
    "INSERT INTO thread_participants (thread_id, user_id) VALUES ('old','alice')",
  );

  // Listing triggers auto-archive.
  await listThreadsForViewer(home.id, "alice");
  assertEquals(await joinedUserIds("old"), []);
});
