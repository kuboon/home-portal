import { assertEquals, assertRejects } from "@std/assert";
import { resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { addMember, createHome } from "./homes.ts";
import { createStamp } from "./stamps.ts";
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
  const home = await createHome({ name: "H", userId: "alice" });
  await addMember(home.id, "bob");
  const thread = await createThread({
    homeId: home.id,
    title: "t",
    userId: "alice",
  });
  return { home, thread };
}

const IMG = {
  storageKey: "home.kbn.one/20260720/abc-photo.jpg",
  contentType: "image/jpeg",
  width: 1200,
  height: 800,
  expiresAt: null,
};

Deno.test("postMessage attaches an image with an optional caption", async () => {
  const { home, thread } = await setup();
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "  みて  ",
    image: IMG,
  });
  assertEquals(posted.kind, "normal");
  assertEquals(posted.body, "みて");
  assertEquals(posted.image, IMG);

  const [m] = await listMessages(thread.id, "alice");
  assertEquals(m.image?.storageKey, IMG.storageKey);
  assertEquals(m.image?.width, 1200);
});

Deno.test("an image post may have an empty body (caption optional)", async () => {
  const { home, thread } = await setup();
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    image: IMG,
  });
  assertEquals(posted.body, "");
  assertEquals(posted.image?.storageKey, IMG.storageKey);
});

Deno.test("a message with neither body nor image is rejected", async () => {
  const { home, thread } = await setup();
  await assertRejects(() =>
    postMessage({ homeId: home.id, threadId: thread.id, authorId: "alice" })
  );
});

Deno.test("image validation: content type and storageKey", async () => {
  const { home, thread } = await setup();
  await assertRejects(() =>
    postMessage({
      homeId: home.id,
      threadId: thread.id,
      authorId: "alice",
      image: { storageKey: "k", contentType: "application/pdf" },
    })
  );
  await assertRejects(() =>
    postMessage({
      homeId: home.id,
      threadId: thread.id,
      authorId: "alice",
      image: { storageKey: "  " },
    })
  );
  // Missing dimensions default to 0 (unknown) rather than failing.
  const ok = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    image: { storageKey: "k", contentType: "image/png" },
  });
  assertEquals(ok.image?.width, 0);
  assertEquals(ok.image?.height, 0);
});

Deno.test("image expiry is stored and round-trips (and rejects garbage)", async () => {
  const { home, thread } = await setup();
  const expiresAt = "2026-07-27T00:00:00.000Z";
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    image: { ...IMG, expiresAt },
  });
  assertEquals(posted.image?.expiresAt, expiresAt);
  const [m] = await listMessages(thread.id, "alice");
  assertEquals(m.image?.expiresAt, expiresAt);

  // A non-ISO expiry is dropped to null rather than persisted verbatim.
  const bad = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    image: { ...IMG, expiresAt: "soon" },
  });
  assertEquals(bad.image?.expiresAt, null);
});

Deno.test("stamp and image cannot be combined", async () => {
  const { home, thread } = await setup();
  const stamp = await createStamp({ ownerId: "alice", storageKey: "s" });
  await assertRejects(() =>
    postMessage({
      homeId: home.id,
      threadId: thread.id,
      authorId: "alice",
      stampId: stamp.id,
      image: IMG,
    })
  );
});

Deno.test("image posts are not editable, but are deletable", async () => {
  const { home, thread } = await setup();
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    body: "cap",
    image: IMG,
  });
  await assertRejects(() =>
    editMessage({ messageId: posted.id, authorId: "alice", body: "x" })
  );

  await tombstoneMessage(posted.id, "alice");
  const [m] = await listMessages(thread.id, "alice");
  assertEquals(m.deleted, true);
  assertEquals(m.image, null);
});

Deno.test("reposting an image post carries the image in the preview", async () => {
  const { home, thread } = await setup();
  const posted = await postMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "alice",
    image: IMG,
  });
  const repost = await repostMessage({
    homeId: home.id,
    threadId: thread.id,
    authorId: "bob",
    sourceMessageId: posted.id,
    body: "いいね",
  });
  assertEquals(repost.repost?.image?.storageKey, IMG.storageKey);

  // Once the original is tombstoned, the preview no longer exposes the image.
  await tombstoneMessage(posted.id, "alice");
  const messages = await listMessages(thread.id, "bob");
  const q = messages.find((m) => m.id === repost.id)!;
  assertEquals(q.repost?.deleted, true);
  assertEquals(q.repost?.image, null);
});
