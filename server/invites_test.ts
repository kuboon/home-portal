import { assert, assertEquals } from "@std/assert";
import {
  closeInvite,
  createInvite,
  resolveInvite,
  setKvForTest,
} from "./invites.ts";

setKvForTest(await Deno.openKv(":memory:"));

Deno.test("invite token resolves to its home, then nothing once closed", async () => {
  const token = await createInvite("home-123");
  assertEquals(await resolveInvite(token), "home-123");

  await closeInvite(token);
  assertEquals(await resolveInvite(token), null);
});

Deno.test("unknown token resolves to null", async () => {
  assert((await resolveInvite(crypto.randomUUID())) === null);
});
