/**
 * KV-backed session storage for Remix v3.
 *
 * Adapts any `@scope/kv` `KvRepo` to the `SessionStorage` interface from
 * `@remix-run/session`. Session IDs are used as KV keys; session data is
 * stored as the `[valueData, flashData]` tuple produced by `Session#data`.
 */

import {
  createSession,
  type Session,
  type SessionStorage,
} from "@remix-run/session";
import type { KvRepo } from "@kuboon/kv";

type SessionDataTuple = Session["data"];

export interface KvSessionStorageOptions {
  /**
   * Whether to reuse session IDs sent from the client that are not found in
   * storage. Default is `false`.
   */
  useUnknownIds?: boolean;
}

/**
 * Create a `SessionStorage` that persists sessions in the given `KvRepo`.
 *
 * The repo's value type must be the `[valueData, flashData]` tuple so that
 * `Session#data` can be round-tripped through it. Use a `KvRepo` with an
 * `expireIn` option configured at the repo level if you want sessions to
 * expire automatically.
 *
 * @param repo The KV repository used to store sessions
 * @param options Optional behavior overrides
 * @returns A `SessionStorage` implementation
 */
export function createKvSessionStorage(
  repo: KvRepo<SessionDataTuple>,
  options?: KvSessionStorageOptions,
): SessionStorage {
  const useUnknownIds = options?.useUnknownIds ?? false;

  return {
    async read(cookie: string | null): Promise<Session> {
      const id = cookie;

      if (id) {
        const data = await repo.entry(id).get();
        if (data !== null) {
          return createSession(id, data);
        }
      }

      return createSession(useUnknownIds && id ? id : undefined);
    },
    async save(session: Session): Promise<string | null> {
      if (session.deleteId) {
        await repo.entry(session.deleteId).update(() => null);
      }

      if (session.destroyed) {
        await repo.entry(session.id).update(() => null);
        return "";
      }

      if (session.dirty) {
        await repo.entry(session.id).update(() => session.data);
        return session.id;
      }

      return null;
    },
  };
}
