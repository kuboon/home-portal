/**
 * Reference-app build entrypoint.
 *
 * Runs the JS bundle (Deno.bundle) and the Tailwind CSS build in
 * parallel, both writing into `reference/bundled/`.
 */

import { buildCss } from "./css.ts";
import { buildJs } from "./js.ts";

export { buildCss, buildJs };

if (import.meta.main) {
  const [js, css] = await Promise.all([buildJs(), buildCss()]);
  console.log("[bundler] js complete", js);
  console.log("[bundler] css complete", css);
}
