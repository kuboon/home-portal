import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { MemoryKvRepo } from "@kuboon/kv/memory.ts";
import type { Session } from "@remix-run/session";

import { createKvSessionStorage } from "./mod.ts";

type SessionDataTuple = Session["data"];

function newStorage(options?: { useUnknownIds?: boolean }) {
  const repo = new MemoryKvRepo<SessionDataTuple>(["session"]);
  return createKvSessionStorage(repo, options);
}

Deno.test("read: 未知の ID はデフォルトで再利用しない", async () => {
  const storage = newStorage();
  const session = await storage.read("unknown");
  assertNotEquals(session.id, "unknown");
});

Deno.test("read: useUnknownIds が true なら未知の ID を再利用する", async () => {
  const storage = newStorage({ useUnknownIds: true });
  const session = await storage.read("unknown");
  assertEquals(session.id, "unknown");
});

Deno.test("read/save: リクエストをまたいでセッションデータを保持する", async () => {
  const storage = newStorage();

  async function requestIndex(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.set("count", Number(session.get("count") ?? 0) + 1);
    return { cookie: await storage.save(session), session };
  }

  const r1 = await requestIndex();
  assertEquals(r1.session.get("count"), 1);

  const r2 = await requestIndex(r1.cookie);
  assertEquals(r2.session.get("count"), 2);

  const r3 = await requestIndex(r2.cookie);
  assertEquals(r3.session.get("count"), 3);
});

Deno.test("destroy: セッション破棄でデータが削除される", async () => {
  const storage = newStorage();

  async function requestIndex(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.set("count", Number(session.get("count") ?? 0) + 1);
    return { cookie: await storage.save(session), session };
  }

  async function requestDestroy(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.destroy();
    return { cookie: await storage.save(session), session };
  }

  const r1 = await requestIndex();
  assertEquals(r1.session.get("count"), 1);

  const r2 = await requestIndex(r1.cookie);
  assertEquals(r2.session.get("count"), 2);

  const r3 = await requestDestroy(r2.cookie);
  assert(r3.session.destroyed);
  assertEquals(r3.cookie, "");

  const r4 = await requestIndex(r3.cookie);
  assertEquals(r4.session.get("count"), 1);
  assertNotEquals(r4.session.id, r3.session.id);
});

Deno.test("save: dirty でないセッションは Cookie を返さない", async () => {
  const storage = newStorage();
  const session = await storage.read(null);
  const cookie = await storage.save(session);
  assertEquals(session.dirty, false);
  assertEquals(cookie, null);
});

Deno.test("flash: 次のリクエストでのみ flash データを取得できる", async () => {
  const storage = newStorage();

  async function requestIndex(cookie: string | null = null) {
    const session = await storage.read(cookie);
    return { cookie: await storage.save(session), session };
  }

  async function requestFlash(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.flash("message", "success!");
    return { cookie: await storage.save(session), session };
  }

  const r1 = await requestIndex();
  assertEquals(r1.session.get("message"), undefined);

  const r2 = await requestFlash(r1.cookie);
  assertEquals(r2.session.get("message"), undefined);

  const r3 = await requestIndex(r2.cookie);
  assertEquals(r3.session.get("message"), "success!");

  const r4 = await requestIndex(r3.cookie);
  assertEquals(r4.session.get("message"), undefined);
});

Deno.test("regenerateId: デフォルトでは旧セッションをストレージに残す", async () => {
  const storage = newStorage();

  async function requestIndex(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.set("count", Number(session.get("count") ?? 0) + 1);
    return { cookie: await storage.save(session), session };
  }

  async function requestLogin(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.regenerateId();
    return { cookie: await storage.save(session), session };
  }

  const r1 = await requestIndex();
  assertEquals(r1.session.get("count"), 1);

  const r2 = await requestLogin(r1.cookie);
  assertNotEquals(r2.session.id, r1.session.id);

  const r3 = await requestIndex(r2.cookie);
  assertEquals(r3.session.get("count"), 2);

  const r4 = await requestIndex(r1.cookie);
  assertEquals(r4.session.get("count"), 2, "旧セッションも残っているはず");
});

Deno.test("regenerateId(true): 旧セッションを削除する", async () => {
  const storage = newStorage();

  async function requestIndex(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.set("count", Number(session.get("count") ?? 0) + 1);
    return { cookie: await storage.save(session), session };
  }

  async function requestLoginAndDelete(cookie: string | null = null) {
    const session = await storage.read(cookie);
    session.regenerateId(true);
    return { cookie: await storage.save(session), session };
  }

  const r1 = await requestIndex();
  assertEquals(r1.session.get("count"), 1);

  const r2 = await requestLoginAndDelete(r1.cookie);
  assertNotEquals(r2.session.id, r1.session.id);

  const r3 = await requestIndex(r2.cookie);
  assertEquals(r3.session.get("count"), 2);

  const r4 = await requestIndex(r1.cookie);
  assertEquals(r4.session.get("count"), 1, "旧セッションは削除されているはず");
});
