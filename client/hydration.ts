/**
 * Client runtime boot for the shell + frame navigation.
 *
 * Bundled into `bundled/mod.js` (via ./mod.ts) and loaded by every shell
 * response as `<script type="module" src="/mod.js">`.
 *
 * `run()` walks the document, finds every `clientEntry` marker emitted by
 * `renderToStream`, and hydrates each one. It also wires up the
 * `<Frame name="content">` region so that clicks on `<a data-rmx-target="content">`
 * links swap just the frame content (via `resolveFrame`) instead of doing a
 * full page navigation.
 */

import { type ResolveFrameOptions, run } from "@remix-run/ui";

const FRAME_HEADER = "rmx-frame";

const app = run({
  async loadModule(moduleUrl: string, exportName: string) {
    const mod = await import(moduleUrl);
    return mod[exportName];
  },
  resolveFrame(src: string, options?: ResolveFrameOptions) {
    const headers = new Headers({
      accept: "text/html",
      [FRAME_HEADER]: "1",
    });
    if (options?.target) headers.set("rmx-target", options.target);
    // A form submitted into the frame arrives with its method and body; only
    // a non-GET submission carries `formData`, and `fetch` rejects a body on
    // GET, so the body rides along exactly when the method allows it.
    const method = options?.method ?? "GET";
    const body = method.toUpperCase() === "GET" ? undefined : options?.formData;
    // The runtime unwraps a Response itself, and reads `redirected`/`url` off
    // it to keep the address bar in step with a redirect — something it cannot
    // recover from a bare body.
    return fetch(src, { headers, method, body, signal: options?.signal });
  },
});

await app.ready();

(globalThis as unknown as { __rmxReady?: boolean }).__rmxReady = true;

console.log("[hydration] runtime ready");
