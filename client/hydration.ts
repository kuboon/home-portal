/**
 * Client runtime boot for the shell + frame navigation.
 *
 * Bundled into `bundled/mod.js` (via ./mod.ts) and loaded by every shell
 * response as `<script type="module" src="/mod.js">`.
 *
 * `run()` walks the document, finds every `clientEntry` marker emitted by
 * `renderToStream`, and hydrates each one. It also wires up the
 * `<Frame name="content">` region so that clicks on `<a rmx-target="content">`
 * links swap just the frame content (via `resolveFrame`) instead of doing a
 * full page navigation.
 */

import { run } from "@remix-run/ui";

const FRAME_HEADER = "rmx-frame";

const app = run({
  async loadModule(moduleUrl: string, exportName: string) {
    const mod = await import(moduleUrl);
    return mod[exportName];
  },
  async resolveFrame(src: string, signal?: AbortSignal, target?: string) {
    const headers = new Headers({
      accept: "text/html",
      [FRAME_HEADER]: "1",
    });
    if (target) headers.set("rmx-target", target);
    const response = await fetch(src, { headers, signal });
    return response.body ?? (await response.text());
  },
});

await app.ready();

(globalThis as unknown as { __rmxReady?: boolean }).__rmxReady = true;

console.log("[hydration] runtime ready");
