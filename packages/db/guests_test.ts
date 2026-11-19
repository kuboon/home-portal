/**
 * Thread guest tests against an in-memory SQLite DB.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { resetClient } from "./sqlite.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { addMember, createHome } from "./homes.ts";
import { createThread, listMessages, postMessage } from "./threads.ts";
import { joinedUserIds } from "./participants.ts";
import {
  addGuest,
  getThreadAccess,
  isGuest,
  listGuests,
  listGuestThreads,
  removeGuest,
} from "./guests.ts";

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  await upsertUser({ id: "carol", displayName: "Carol" });
  const home = await createHome({ name: "H", userId: "alice" });
  await addMember(home.id, "bob");
  const t1 = await createThread({
    homeId: home.id,
    title: "t1",
    userId: "alice",
  });
  const t2 = await createThread({
    homeId: home.id,
    title: "t2",
    userId: "alice",
  });
  return { home, t1, t2 };
}

Deno.test("getThreadAccess: admin / member / guest / none", async () => {
  const { t1, t2 } = await setup();
  assertEquals((await getThreadAccess(t1.id, "alice"))?.role, "admin");
  assertEquals((await getThreadAccess(t1.id, "bob"))?.role, "member");
  assertEquals(await getThreadAccess(t1.id, "carol"), null);
  assertEquals(await getThreadAccess("nope", "alice"), null);

  await addGuest(t1.id, "carol", "alice");
  assertEquals((await getThreadAccess(t1.id, "carol"))?.role, "guest");
  // Only that thread.
  assertEquals(await getThreadAccess(t2.id, "carol"), null);
});

Deno.test("addGuest joins the thread; idempotent; members rejected", async () => {
  const { home, t1 } = await setup();
  await addGuest(t1.id, "carol", "alice");
  await addGuest(t1.id, "carol", "alice");
  assert((await joinedUserIds(t1.id)).includes("carol"));
  const guests = await listGuests(t1.id);
  assertEquals(guests.map((g) => g.userId), ["carol"]);
  assertEquals(guests[0].invitedBy, "alice");

  await assertRejects(() => addGuest(t1.id, "bob", "alice"), Error, "member");
  await assertRejects(() => addGuest(t1.id, "nobody", "alice"), Error);

  const mine = await listGuestThreads("carol");
  assertEquals(mine.length, 1);
  assertEquals(mine[0].home, { id: home.id, name: "H" });
  assertEquals(mine[0].thread.id, t1.id);
  assertEquals((await listGuestThreads("carol", "other")).length, 0);
});

Deno.test("removeGuest revokes access and notifications", async () => {
  const { t1 } = await setup();
  await addGuest(t1.id, "carol", "alice");
  await removeGuest(t1.id, "carol");
  assertEquals(await isGuest(t1.id, "carol"), false);
  assertEquals(await getThreadAccess(t1.id, "carol"), null);
  assertEquals((await joinedUserIds(t1.id)).includes("carol"), false);
  await assertRejects(() => removeGuest(t1.id, "carol"), Error);
});

Deno.test("becoming a member drops guest rows", async () => {
  const { home, t1 } = await setup();
  await addGuest(t1.id, "carol", "alice");
  await addMember(home.id, "carol");
  assertEquals(await isGuest(t1.id, "carol"), false);
  assertEquals((await getThreadAccess(t1.id, "carol"))?.role, "member");
});

Deno.test("guest posts are flagged authorIsGuest", async () => {
  const { home, t1 } = await setup();
  await addGuest(t1.id, "carol", "alice");
  await postMessage({
    homeId: home.id,
    threadId: t1.id,
    authorId: "carol",
    body: "hi",
  });
  await postMessage({
    homeId: home.id,
    threadId: t1.id,
    authorId: "bob",
    body: "yo",
  });
  const msgs = await listMessages(t1.id, "alice", true);
  assertEquals(
    msgs.map((m) => [m.authorName, m.authorIsGuest]),
    [["Carol", true], ["Bob", false]],
  );
});
