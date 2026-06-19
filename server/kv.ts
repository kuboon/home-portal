/**
 * The server's single Deno KV connection.
 *
 * Every server module shares one lazily-opened handle instead of calling
 * `Deno.openKv()` itself. The store location comes from `KV_DEFAULT_PATH`
 * (unset => Deno's default per-deployment store; tests inject `:memory:` via
 * {@link setKvForTest}).
 */

let kvPromise: Promise<Deno.Kv> | undefined;

/** The shared KV handle, opened on first use from `KV_DEFAULT_PATH`. */
export function getKv(): Promise<Deno.Kv> {
  return kvPromise ??= Deno.openKv(Deno.env.get("KV_DEFAULT_PATH"));
}

/** Override the shared KV instance (tests use an in-memory one). */
export function setKvForTest(instance: Deno.Kv): void {
  kvPromise = Promise.resolve(instance);
}
