/**
 * Cloudflare Workers entrypoint.
 *
 * - `fetch`: the app router. Static assets (`server/bundled/`) are served by
 *   Workers Static Assets before this runs, so only dynamic routes get here.
 * - `scheduled`: sweeps expired KV rows (sessions, invites, rate-limit
 *   windows, …), since D1 has no TTL.
 * - `ChannelHub`: the realtime Durable Object (one per channel).
 *
 * Bindings exist only per invocation, so the database and the realtime hub
 * are installed lazily from the latest `env`. Bundled by
 * `bundler/worker.ts`, deployed with `cf` (see `cloudflare/`).
 */

import { type D1DatabaseLike, setDatabase } from "@scope/db";

import { sweepKv } from "./kv.ts";
import { setRealtimeHub } from "./realtime.ts";
import {
  ChannelHub,
  durableObjectHub,
  type DurableObjectNamespaceLike,
} from "./realtime_do.ts";
import { createAppRouter } from "./router.ts";

export { ChannelHub };

export interface Env {
  DB: D1DatabaseLike;
  CHANNEL_HUB: DurableObjectNamespaceLike;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

let env: Env | undefined;
const current = (): Env => {
  if (!env) throw new Error("Worker env not initialised");
  return env;
};

setDatabase(() => current().DB);
setRealtimeHub(durableObjectHub(() => current().CHANNEL_HUB));

const router = createAppRouter();

export default {
  fetch(request: Request, nextEnv: Env): Promise<Response> {
    env = nextEnv;
    return router.fetch(request);
  },

  scheduled(_event: unknown, nextEnv: Env, ctx: ExecutionContextLike): void {
    env = nextEnv;
    ctx.waitUntil(
      sweepKv().then((n) => console.log(`[cron] swept ${n} expired kv rows`)),
    );
  },
};
