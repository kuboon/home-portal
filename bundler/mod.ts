/**
 * Build entrypoint.
 *
 * Runs the JS bundle (Deno.bundle) and the Tailwind CSS build in parallel,
 * then copies static client assets (the service worker), all into
 * `server/bundled/`.
 */

import { buildCss } from "./css.ts";
import { buildJs } from "./js.ts";

export { buildCss, buildJs };

/** Copy plain (non-bundled) client assets into the served bundled dir. */
export async function copyAssets(): Promise<void> {
  const out = new URL("../server/bundled/", import.meta.url);
  await Deno.mkdir(out, { recursive: true });
  await Deno.copyFile(
    new URL("../client/sw.js", import.meta.url),
    new URL("sw.js", out),
  );
}

if (import.meta.main) {
  const [js, css] = await Promise.all([buildJs(), buildCss(), copyAssets()]);
  console.log("[bundler] js complete", js);
  console.log("[bundler] css complete", css);
}
