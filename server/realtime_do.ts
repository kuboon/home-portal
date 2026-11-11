/**
 * Realtime fan-out on Cloudflare: one Durable Object ({@link ChannelHub}) per
 * channel, addressed by name (`thread:<id>` / `main:<homeId>`).
 *
 * A watcher (the SSE handler in some Worker isolate) holds a streaming
 * `GET /watch` open against the channel's object; a poster sends
 * `POST /signal`, and the object writes one byte to every open watch. The
 * object keeps no storage: if it is restarted (e.g. on deploy) the watch
 * streams end, the SSE responses close, and clients reconnect and re-fetch.
 */

import type { Channel, RealtimeHub } from "./realtime.ts";

const SIGNAL = new Uint8Array([0x73]); // "s"
const HEARTBEAT = new Uint8Array([0x68]); // "h"
const HEARTBEAT_MS = 30_000;

/** The parts of `DurableObjectNamespace` we use. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(
    id: never,
  ): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** The Durable Object class (exported from the Worker entrypoint). */
export class ChannelHub {
  #writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(_state: unknown, _env: unknown) {}

  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/signal") {
      this.#broadcast(SIGNAL);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && pathname === "/watch") {
      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      this.#writers.add(writer);
      writer.closed.catch(() => {}).finally(() => this.#drop(writer));
      this.#heartbeat ??= setInterval(
        () => this.#broadcast(HEARTBEAT),
        HEARTBEAT_MS,
      );
      return new Response(readable, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  }

  /** Write to every watcher without waiting; a failed write drops it. */
  #broadcast(chunk: Uint8Array): void {
    for (const writer of this.#writers) {
      writer.write(chunk).catch(() => {
        this.#drop(writer);
        writer.abort().catch(() => {});
      });
    }
  }

  #drop(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.#writers.delete(writer);
    if (this.#writers.size === 0 && this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }
}

/** A {@link RealtimeHub} over the `ChannelHub` namespace binding. */
export function durableObjectHub(
  namespace: () => DurableObjectNamespaceLike,
): RealtimeHub {
  const stub = (channel: Channel) => {
    const ns = namespace();
    return ns.get(ns.idFromName(channel) as never);
  };
  return {
    async signal(channel) {
      try {
        const res = await stub(channel).fetch("https://hub/signal", {
          method: "POST",
        });
        await res.body?.cancel();
      } catch (error) {
        // A missed signal only delays the update until the next one; never
        // fail the post that triggered it.
        console.warn("[realtime] signal failed", channel, error);
      }
    },
    async watch(channel) {
      const res = await stub(channel).fetch("https://hub/watch");
      if (!res.ok || !res.body) {
        throw new Error(`[realtime] watch ${channel}: ${res.status}`);
      }
      // One output chunk per chunk that carries a signal; heartbeats only
      // keep the internal stream alive.
      return res.body.pipeThrough(
        new TransformStream<Uint8Array, number>({
          transform(chunk, controller) {
            if (chunk.includes(SIGNAL[0])) controller.enqueue(Date.now());
          },
        }),
      );
    },
  };
}
