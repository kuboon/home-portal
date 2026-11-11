/**
 * Server-Sent Events over a Deno KV watch.
 *
 * The stream carries no payload: it says *that* something changed, and the
 * client re-fetches from Turso (the source of truth). See `realtime.ts`.
 */

/** Interval between keep-alive comment frames, in milliseconds. */
const HEARTBEAT_MS = 25_000;

/**
 * Wrap a KV watch stream as an SSE response. Emits a `ready` ping, then a
 * `sync` ping on every change.
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
        } catch { /* client gone */ }
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
