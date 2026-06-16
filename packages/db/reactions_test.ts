import { assert, assertEquals, assertRejects } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { createHome } from "./homes.ts";
import { createThread, listMessages, postMessage } from "./threads.ts";
import { MAX_STAMPS_PER_MESSAGE, toggleReaction } from "./reactions.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  const home = await createHome({ name: "H", userId: "alice" });
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  const msg = await postMessage({
    threadId: thread.id,
    authorId: "alice",
    body: "hi",
  });
  return { thread, msg };
}

Deno.test("toggleReaction adds then removes; aggregated in listMessages", async () => {
  const { thread, msg } = await setup();

  assertEquals((await toggleReaction(msg.id, "alice", "👍")).added, true);
  let msgs = await listMessages(thread.id, "alice");
  assertEquals(msgs[0].reactions, [{ stamp: "👍", count: 1, mine: true }]);

  assertEquals((await toggleReaction(msg.id, "alice", "👍")).added, false);
  msgs = await listMessages(thread.id, "alice");
  assertEquals(msgs[0].reactions, []);
});

Deno.test("a user is capped at MAX_STAMPS_PER_MESSAGE distinct stamps", async () => {
  const { msg } = await setup();
  const stamps = ["👍", "❤️", "😂", "🎉", "😮"];
  assertEquals(stamps.length, MAX_STAMPS_PER_MESSAGE);
  for (const s of stamps) await toggleReaction(msg.id, "alice", s);
  await assertRejects(() => toggleReaction(msg.id, "alice", "🙏"));
  // Removing one frees a slot.
  assertEquals((await toggleReaction(msg.id, "alice", "👍")).added, false);
  assert((await toggleReaction(msg.id, "alice", "🙏")).added);
});
