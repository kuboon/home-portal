import { assert, assertEquals } from "@std/assert";
import { createSqliteD1 } from "@kuboon/kv/d1Sqlite.ts";
import {
  closeInvite,
  createInvite,
  refreshInvite,
  resolveInvite,
  setKvForTest,
} from "./invites.ts";

setKvForTest(createSqliteD1());

Deno.test("invite token resolves to its home, then nothing once closed", async () => {
  const token = await createInvite("home-123");
  assertEquals(await resolveInvite(token), "home-123");

  await closeInvite(token);
  assertEquals(await resolveInvite(token), null);
});

Deno.test("unknown token resolves to null", async () => {
  assert((await resolveInvite(crypto.randomUUID())) === null);
});

Deno.test("refresh keeps a live token and reports an unknown one", async () => {
  const token = await createInvite("home-456");
  assert(await refreshInvite(token));
  assertEquals(await resolveInvite(token), "home-456");
  assert(!(await refreshInvite(crypto.randomUUID())));
});
