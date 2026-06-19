import { assertEquals } from "@std/assert";
import { type BackoffState, nextBackoff } from "./notify.ts";

const BASE = 60_000;
const CAP = 240_000;

Deno.test("nextBackoff: first send always allowed at base interval", () => {
  const { send, next } = nextBackoff(null, 1_000);
  assertEquals(send, true);
  assertEquals(next, { lastSentAt: 1_000, intervalMs: BASE });
});

Deno.test("nextBackoff: within interval is suppressed", () => {
  const state: BackoffState = { lastSentAt: 0, intervalMs: BASE };
  assertEquals(nextBackoff(state, BASE - 1).send, false);
});

Deno.test("nextBackoff: interval doubles up to the cap", () => {
  let state: BackoffState = { lastSentAt: 0, intervalMs: BASE };
  let now = BASE; // exactly due
  let r = nextBackoff(state, now);
  assertEquals(r.send, true);
  assertEquals(r.next.intervalMs, 2 * BASE); // 1m → 2m
  state = r.next;

  now += 2 * BASE;
  r = nextBackoff(state, now);
  assertEquals(r.next.intervalMs, CAP); // 2m → 4m (cap)
  state = r.next;

  now += CAP - 1; // not yet due (just under cap)
  assertEquals(nextBackoff(state, now).send, false);
});

Deno.test("nextBackoff: a long quiet gap resets to base", () => {
  const state: BackoffState = { lastSentAt: 0, intervalMs: CAP };
  const r = nextBackoff(state, CAP); // gap >= cap
  assertEquals(r.send, true);
  assertEquals(r.next.intervalMs, BASE);
});
