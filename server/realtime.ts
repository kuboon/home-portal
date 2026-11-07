/**
 * Realtime change signalling.
 *
 * D1 is the source of truth for messages; this module only carries a
 * per-channel "something changed" signal. Posting bumps the channel; SSE
 * handlers watch it and, on each signal, tell the client to re-fetch.
 *
 * The transport is pluggable ({@link setRealtimeHub}):
 * - default: an in-process hub, enough for tests and the single-process
 *   local Deno dev server;
 * - Workers: one Durable Object per channel (`./realtime_do.ts`), which
 *   fans out across isolates and data centres.
 */

/** A channel name: a thread, or a home's main channel. */
export type Channel = `thread:${string}` | `main:${string}`;

export interface RealtimeHub {
  /** Wake every watcher of `channel`. */
  signal(channel: Channel): Promise<void>;
  /** A stream yielding one chunk per signal; ends if the hub goes away. */
  watch(channel: Channel): Promise<ReadableStream<unknown>>;
}

/** Single-process hub (tests, local dev). */
export function memoryHub(): RealtimeHub {
  const watchers = new Map<Channel, Set<ReadableStreamDefaultController>>();
  return {
    signal(channel) {
      for (const controller of watchers.get(channel) ?? []) {
        try {
          controller.enqueue(Date.now());
        } catch { /* closed */ }
      }
      return Promise.resolve();
    },
    watch(channel) {
      let self: ReadableStreamDefaultController | undefined;
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            self = controller;
            let set = watchers.get(channel);
            if (!set) watchers.set(channel, set = new Set());
            set.add(controller);
          },
          cancel() {
            const set = watchers.get(channel);
            if (self) set?.delete(self);
            if (set?.size === 0) watchers.delete(channel);
          },
        }),
      );
    },
  };
}

let hub: RealtimeHub = memoryHub();

/** Install the transport (the Worker entrypoint installs the DO hub). */
export function setRealtimeHub(next: RealtimeHub): void {
  hub = next;
}

/** Bump a thread's signal so watchers re-query for new messages. */
export async function signalThread(threadId: string): Promise<void> {
  await hub.signal(`thread:${threadId}`);
}

/** A stream that yields once per change to the thread. */
export function watchThread(
  threadId: string,
): Promise<ReadableStream<unknown>> {
  return hub.watch(`thread:${threadId}`);
}

/** Bump a home's main-channel signal (posts with no thread). */
export async function signalMainChannel(homeId: string): Promise<void> {
  await hub.signal(`main:${homeId}`);
}

/** A stream that yields once per change to a home's main channel. */
export function watchMainChannel(
  homeId: string,
): Promise<ReadableStream<unknown>> {
  return hub.watch(`main:${homeId}`);
}
