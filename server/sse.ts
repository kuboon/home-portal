/**
 * Server-Sent Events over a realtime watch stream.
 *
 * The stream carries no payload: it says *that* something changed, and the
 * client re-fetches from D1 (the source of truth). See `realtime.ts`.
 */

/** Interval between keep-alive comment frames, in milliseconds. */
const HEARTBEAT_MS = 25_000;

/**
 * Wrap a realtime watch stream as an SSE response. Emits a `ready` ping, then
 * a `sync` ping on every change. If the watch ends (e.g. the hub restarted on
 * deploy) the response ends too, so the client reconnects and re-syncs.
 *
 * A comment frame (`: ping`) goes out every {@link HEARTBEAT_MS} so an idle
 * stream is not cut by a proxy's idle timeout. Chat traffic used to mask this;
 * a calendar stream can sit silent for hours. Clients ignore the frame: it has
 * no `event:` line.
 */
export function sseFromWatch(
  request: Request,
  watch: ReadableStream<unknown>,
): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop(); // the stream is already closed
        }
      };
      const ping = (event: string) => send(`event: ${event}\ndata: {}\n\n`);
      ping("ready");

      const reader = watch.getReader();
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      let stopped = false;
      stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", stop);
        reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch { /* already closed */ }
      };
      request.signal.addEventListener("abort", stop);

      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
            ping("sync");
          }
        } catch { /* hub or client gone */ }
        stop();
      })();
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
