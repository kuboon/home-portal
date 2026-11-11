import { assert } from "@std/assert";
import { createSqliteD1 } from "@kuboon/kv/d1Sqlite.ts";
import { allow } from "./rate_limit.ts";

Deno.test("allow enforces a fixed-window limit and resets next window", async () => {
  const db = createSqliteD1();
  try {
    const key = ["t", "u1"];
    // limit 2 within a 60s window, clock fixed at t=1000ms (bucket 0)
    assert(await allow(db, key, 2, 60_000, 1_000));
    assert(await allow(db, key, 2, 60_000, 1_000));
    assert(!(await allow(db, key, 2, 60_000, 1_000))); // 3rd blocked

    // next window (t=61_000ms → bucket 1) allows again
    assert(await allow(db, key, 2, 60_000, 61_000));
  } finally {
    db.close();
  }
});

Deno.test("allow isolates buckets by key", async () => {
  const db = createSqliteD1();
  try {
    assert(await allow(db, ["a"], 1, 1_000, 0));
    assert(!(await allow(db, ["a"], 1, 1_000, 0)));
    assert(await allow(db, ["b"], 1, 1_000, 0)); // different key, own budget
  } finally {
    db.close();
  }
});
