/**
 * The server's key-value store: `@kuboon/kv`'s D1 backend over the same D1
 * database as the domain data (the `kv` table, migration 0015).
 *
 * This replaces Deno KV. Workers KV is not an option because sessions,
 * invites and rate limits need compare-and-set, which an eventually
 * consistent store cannot give; D1 has a single primary, so conditional
 * writes are atomic. D1 has no TTL: expired rows are invisible to reads and
 * swept by the Worker's scheduled handler ({@link sweepKv}).
 *
 * The database is resolved per statement (Worker bindings only exist inside
 * a request); tests swap in a `node:sqlite` one with {@link setKvForTest}.
 */

import { D1KvRepo, type D1Like, lazyD1, sweepExpired } from "@kuboon/kv/d1.ts";
import type { KvOptions, KvRepo } from "@kuboon/kv";
import { getD1 } from "@scope/db";

let override: D1Like | undefined;

/** The D1 database backing every repo (schema ensured on first use). */
export const kvDb: D1Like = lazyD1(() => override ?? getD1());

/** A typed repo under `prefix` (e.g. `["invite"]`). */
export function kvRepo<T>(
  prefix: string[],
  options?: KvOptions,
): KvRepo<T> {
  return new D1KvRepo<T>(kvDb, prefix, options);
}

/** Delete expired rows. Called from the scheduled (cron) handler. */
export function sweepKv(): Promise<number> {
  return sweepExpired(kvDb);
}

/** Route every repo to `db` (tests use an in-memory `node:sqlite` one). */
export function setKvForTest(db: D1Like): void {
  override = db;
}
