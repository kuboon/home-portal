import { assert } from "@std/assert";
import { allow } from "./rate_limit.ts";

Deno.test("allow enforces a fixed-window limit and resets next window", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const key = ["t", "u1"];
    // limit 2 within a 60s window, clock fixed at t=1000ms (bucket 0)
    assert(await allow(kv, key, 2, 60_000, 1_000));
    assert(await allow(kv, key, 2, 60_000, 1_000));
    assert(!(await allow(kv, key, 2, 60_000, 1_000))); // 3rd blocked

    // next window (t=61_000ms → bucket 1) allows again
    assert(await allow(kv, key, 2, 60_000, 61_000));
  } finally {
    kv.close();
  }
});

Deno.test("allow isolates buckets by key", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    assert(await allow(kv, ["a"], 1, 1_000, 0));
    assert(!(await allow(kv, ["a"], 1, 1_000, 0)));
    assert(await allow(kv, ["b"], 1, 1_000, 0)); // different key, own budget
  } finally {
    kv.close();
  }
});
