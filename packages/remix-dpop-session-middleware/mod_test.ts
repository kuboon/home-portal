import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";
import { createSession, Session } from "@remix-run/session";
import { init, InMemoryKeyRepository } from "@kuboon/dpop";
import { MemoryKvRepo } from "@kuboon/kv/memory.ts";
import { createKvSessionStorage } from "@scope/session-storage-kv";

import { DpopSession, dpopSession } from "./mod.ts";

type SessionDataTuple = Session["data"];

function newStorage() {
  return createKvSessionStorage(
    new MemoryKvRepo<SessionDataTuple>(["dpop-session"]),
  );
}

function newRouter() {
  const storage = newStorage();
  const router = createRouter({
    middleware: [dpopSession({ sessionStorage: storage })],
  });
  router.map("/count", ({ get }) => {
    const session = get(DpopSession);
    session.set("count", Number(session.get("count") ?? 0) + 1);
    return Response.json({
      count: session.get("count"),
      thumbprint: session.thumbprint,
    });
  });
  router.map("/destroy", ({ get }) => {
    const session = get(DpopSession);
    session.destroy();
    return new Response("destroyed");
  });
  return { router, storage };
}

async function newClient(
  // deno-lint-ignore no-explicit-any
  router: { fetch: (input: any, init?: RequestInit) => Promise<Response> },
) {
  return await init({
    keyStore: new InMemoryKeyRepository(),
    fetch: router.fetch.bind(router),
  });
}

Deno.test("リクエスト間でセッションデータが thumbprint で永続化される", async () => {
  const { router } = newRouter();
  const { fetchDpop, thumbprint } = await newClient(router);

  const r1 = await (await fetchDpop("https://app/count")).json();
  assertEquals(r1.count, 1);
  assertEquals(r1.thumbprint, thumbprint);

  const r2 = await (await fetchDpop("https://app/count")).json();
  assertEquals(r2.count, 2);

  const r3 = await (await fetchDpop("https://app/count")).json();
  assertEquals(r3.count, 3);
});

Deno.test("クライアント鍵が異なれば独立したセッションになる", async () => {
  const { router } = newRouter();
  const clientA = await newClient(router);
  const clientB = await newClient(router);

  assertNotEquals(clientA.thumbprint, clientB.thumbprint);

  const a1 = await (await clientA.fetchDpop("https://app/count")).json();
  const a2 = await (await clientA.fetchDpop("https://app/count")).json();
  const b1 = await (await clientB.fetchDpop("https://app/count")).json();

  assertEquals(a1.count, 1);
  assertEquals(a2.count, 2);
  assertEquals(b1.count, 1);
});

Deno.test("destroy でセッションが消える", async () => {
  const { router } = newRouter();
  const { fetchDpop } = await newClient(router);

  const r1 = await (await fetchDpop("https://app/count")).json();
  assertEquals(r1.count, 1);

  const destroyed = await fetchDpop("https://app/destroy");
  assertEquals(await destroyed.text(), "destroyed");

  const r2 = await (await fetchDpop("https://app/count")).json();
  assertEquals(r2.count, 1, "破棄後はカウントがリセットされる");
});

Deno.test("DPoP ヘッダがない場合は 401 を返す", async () => {
  const { router } = newRouter();
  const response = await router.fetch("https://app/count");
  assertEquals(response.status, 401);
});

Deno.test("不正な DPoP プルーフは 401 を返す", async () => {
  const { router } = newRouter();
  const response = await router.fetch("https://app/count", {
    headers: { DPoP: "not-a-valid-jwt" },
  });
  assertEquals(response.status, 401);
});

Deno.test("DpopSession は @remix-run/session の Session と共存できる", async () => {
  const dpopStorage = newStorage();
  const cookieStore = new Map<string, SessionDataTuple>();

  const router = createRouter({
    middleware: [dpopSession({ sessionStorage: dpopStorage })],
  });

  router.map("/whoami", (context) => {
    const dpop = context.get(DpopSession);
    // Simulate a separate Session set by another middleware/handler.
    const cookie = context.has(Session)
      ? context.get(Session)
      : createSession("cookie-id", cookieStore.get("cookie-id"));
    if (!context.has(Session)) context.set(Session, cookie);

    dpop.set("dpopCount", Number(dpop.get("dpopCount") ?? 0) + 1);
    cookie.set("cookieCount", Number(cookie.get("cookieCount") ?? 0) + 1);
    cookieStore.set(cookie.id, cookie.data);

    return Response.json({
      thumbprint: dpop.thumbprint,
      dpopCount: dpop.get("dpopCount"),
      cookieCount: cookie.get("cookieCount"),
      sameInstance: (dpop as Session) === cookie,
    });
  });

  const { fetchDpop, thumbprint } = await newClient(router);
  const r1 = await (await fetchDpop("https://app/whoami")).json();
  assertEquals(r1.thumbprint, thumbprint);
  assertEquals(r1.dpopCount, 1);
  assertEquals(r1.cookieCount, 1);
  assertEquals(
    r1.sameInstance,
    false,
    "DpopSession と Session は別インスタンス",
  );

  const r2 = await (await fetchDpop("https://app/whoami")).json();
  assertEquals(r2.dpopCount, 2);
  assertEquals(r2.cookieCount, 2);
});

Deno.test("二重に dpopSession を入れると Existing DPoP session エラー", async () => {
  const storage = newStorage();
  const router = createRouter({
    middleware: [
      dpopSession({ sessionStorage: storage }),
      dpopSession({ sessionStorage: storage }),
    ],
  });
  router.map("/", () => new Response("ok"));

  const { fetchDpop } = await newClient(router);
  await assertRejects(
    () => fetchDpop("https://app/"),
    Error,
    "Existing DPoP session found",
  );
});

Deno.test("ハンドラが DpopSession を別インスタンスに差し替えるとエラー", async () => {
  const storage = newStorage();
  const router = createRouter({
    middleware: [dpopSession({ sessionStorage: storage })],
  });
  router.map("/", (context) => {
    // deno-lint-ignore no-explicit-any
    context.set(DpopSession, createSession() as any);
    return new Response("ok");
  });

  const { fetchDpop } = await newClient(router);
  await assertRejects(
    () => fetchDpop("https://app/"),
    Error,
    "Cannot save DPoP session that was initialized by another middleware/handler",
  );
});

Deno.test("DpopSession.regenerateId は禁止", () => {
  const session = new DpopSession("thumb", { kty: "EC" });
  let threw: unknown;
  try {
    session.regenerateId();
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof Error);
  assertEquals(
    (threw as Error).message,
    "Cannot regenerate ID of a DpopSession — the ID is derived from the client key",
  );
});

Deno.test("カスタム onError でレスポンスを差し替えられる", async () => {
  const router = createRouter({
    middleware: [
      dpopSession({
        sessionStorage: newStorage(),
        onError: (error) => new Response(`err:${error}`, { status: 418 }),
      }),
    ],
  });
  router.map("/", () => new Response("ok"));

  const response = await router.fetch("https://app/");
  assertEquals(response.status, 418);
  const body = await response.text();
  assert(body.startsWith("err:"));
});
