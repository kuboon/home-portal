import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { db, resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { addMember, createHome } from "./homes.ts";
import {
  canUseStamp,
  createStamp,
  getStamp,
  listHomeStamps,
  listLibrary,
  MAX_LIBRARY_STAMPS,
  removeFromLibrary,
  touchStamp,
} from "./stamps.ts";
import {
  createThread,
  editMessage,
  listMessages,
  postMessage,
  repostMessage,
  tombstoneMessage,
} from "./threads.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  await upsertUser({ id: "carol", displayName: "Carol" });
  const home = await createHome({ name: "H", userId: "alice" });
  await addMember(home.id, "bob");
  return { home };
}

/** Force a library entry's LRU position (tests can't rely on wall-clock). */
async function setLastUsed(
  userId: string,
  stampId: string,
  at: string,
): Promise<void> {
  await (await db()).execute({
    sql:
      "UPDATE user_stamps SET last_used_at = ? WHERE user_id = ? AND stamp_id = ?",
    args: [at, userId, stampId],
  });
}

Deno.test("createStamp registers and adds to the owner's library", async () => {
  await setup();
  const stamp = await createStamp({
    ownerId: "alice",
    label: "  やったー  ",
    storageKey: "home.kbn.one/20260713/abc-cat.png",
    contentType: "image/png",
  });
  assertEquals(stamp.label, "やったー");
  assertEquals(stamp.storageKey, "home.kbn.one/20260713/abc-cat.png");

  const lib = await listLibrary("alice");
  assertEquals(lib.map((s) => s.id), [stamp.id]);
});

Deno.test("createStamp validates input and defaults the label", async () => {
  await setup();
  await assertRejects(() =>
    createStamp({ ownerId: "alice", storageKey: "  " })
  );
  await assertRejects(() =>
    createStamp({ ownerId: "alice", storageKey: "k", contentType: "text/html" })
  );
  const stamp = await createStamp({ ownerId: "alice", storageKey: "k" });
  assertEquals(stamp.label, "スタンプ");
});

Deno.test("library caps at MAX_LIBRARY_STAMPS with LRU eviction", async () => {
  await setup();
  const ids: string[] = [];
  for (let i = 0; i < MAX_LIBRARY_STAMPS; i++) {
    const s = await createStamp({ ownerId: "alice", storageKey: `k${i}` });
    ids.push(s.id);
    // Deterministic, strictly increasing recency: k0 is the LRU.
    await setLastUsed(
      "alice",
      s.id,
      `2026-01-01 00:00:${String(i).padStart(2, "0")}`,
    );
  }
  assertEquals((await listLibrary("alice")).length, MAX_LIBRARY_STAMPS);

  // A 21st stamp evicts the least-recently-used (k0)…
  const extra = await createStamp({ ownerId: "alice", storageKey: "k-extra" });
  let lib = await listLibrary("alice");
  assertEquals(lib.length, MAX_LIBRARY_STAMPS);
  assertEquals(lib[0].id, extra.id);
  assertFalse(lib.some((s) => s.id === ids[0]));

  // …but the evicted stamp itself still exists (messages may reference it).
  assert(await getStamp(ids[0]));

  // Re-using an old entry moves it to the front instead of adding.
  await touchStamp("alice", ids[5]);
  lib = await listLibrary("alice");
  assertEquals(lib[0].id, ids[5]);
  assertEquals(lib.length, MAX_LIBRARY_STAMPS);
});

Deno.test("touchStamp auto-adds someone else's stamp to my library", async () => {
  await setup();
  const stamp = await createStamp({ ownerId: "alice", storageKey: "k" });
  assertEquals(await listLibrary("bob"), []);
  await touchStamp("bob", stamp.id);
  assertEquals((await listLibrary("bob")).map((s) => s.id), [stamp.id]);
});

Deno.test("removeFromLibrary keeps the stamp itself", async () => {
  await setup();
  const stamp = await createStamp({ ownerId: "alice", storageKey: "k" });
  await removeFromLibrary("alice", stamp.id);
  assertEquals(await listLibrary("alice"), []);
  assert(await getStamp(stamp.id));
});

Deno.test("canUseStamp: own library, home sharing, and denial", async () => {
  const { home } = await setup();
  const stamp = await createStamp({ ownerId: "alice", storageKey: "k" });

  // Owner (library) and home member (sharing) may use it.
  assert(await canUseStamp(stamp.id, "alice", home.id));
  assert(await canUseStamp(stamp.id, "bob", home.id));

  // carol is not in the home and doesn't own it.
  const other = await createHome({ name: "O", userId: "carol" });
  assertFalse(await canUseStamp(stamp.id, "carol", other.id));

  // Once auto-added to carol's library it is usable anywhere she posts.
  await touchStamp("carol", stamp.id);
  assert(await canUseStamp(stamp.id, "carol", other.id));

  assertFalse(await canUseStamp("missing", "alice", home.id));
});

Deno.test("listHomeStamps: members' stamps, tagged with inLibrary", async () => {
  const { home } = await setup();
  const a = await createStamp({ ownerId: "alice", storageKey: "ka" });
  const b = await createStamp({ ownerId: "bob", storageKey: "kb" });
  await createStamp({ ownerId: "carol", storageKey: "kc" }); // not a member

  const forAlice = await listHomeStamps(home.id, "alice");
  assertEquals(new Set(forAlice.map((s) => s.id)), new Set([a.id, b.id]));
  assertEquals(
    forAlice.find((s) => s.id === a.id)?.inLibrary,
    true,
  );
  assertEquals(forAlice.find((s) => s.id === b.id)?.inLibrary, false);
});

Deno.test("postMessage with stampId posts a stamp message", async () => {
  const { home } = await setup();
  const stamp = await createStamp({
    ownerId: "alice",
    label: "ねこ",
    storageKey: "k",
    contentType: "image/webp",
  });
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    stampId: stamp.id,
  });
  assertEquals(posted.kind, "stamp");
  assertEquals(posted.body, "ねこ");
  assertEquals(posted.stamp?.storageKey, "k");

  const [m] = await listMessages(thread.id, "bob");
  assertEquals(m.kind, "stamp");
  assertEquals(m.stamp?.id, stamp.id);
  assertEquals(m.stamp?.label, "ねこ");

  // Unknown stamp is rejected.
  await assertRejects(() =>
    postMessage({
      homeId: home.id,
      threadId: thread.id,
      authorId: "bob",
      stampId: "missing",
    })
  );
});

Deno.test("stamp messages: not editable, deletable, repostable", async () => {
  const { home } = await setup();
  const stamp = await createStamp({
    ownerId: "alice",
    label: "ねこ",
    storageKey: "k",
  });
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    stampId: stamp.id,
  });

  // Stamps cannot be edited (only kind='normal' is editable).
  await assertRejects(() =>
    editMessage({ messageId: posted.id, authorId: "alice", body: "x" })
  );

  // Reposting a stamp post carries the stamp in the quote preview.
  const repost = await repostMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    sourceMessageId: posted.id,
    body: "これすき",
  });
  assertEquals(repost.repost?.stamp?.id, stamp.id);

  // Author delete leaves a tombstone and hides the stamp.
  await tombstoneMessage(posted.id, "alice");
  const messages = await listMessages(thread.id, "alice");
  const deleted = messages.find((m) => m.id === posted.id)!;
  assertEquals(deleted.deleted, true);
  assertEquals(deleted.stamp, null);
  // The repost preview of a tombstoned original reads as deleted too.
  const q = messages.find((m) => m.id === repost.id)!;
  assertEquals(q.repost?.deleted, true);
  assertEquals(q.repost?.stamp, null);
});
