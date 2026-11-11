/**
 * Server bundling for Cloudflare Workers via `Deno.bundle` (unstable).
 *
 * Bundles `server/worker.ts` (router, controllers, `@scope/*` packages and
 * their jsr:/npm: deps) into one ES module at `cloudflare/dist/worker.js`,
 * which `cf build` (run from `cloudflare/`) takes as the Worker entrypoint.
 * `cloudflare:` imports, if any, are left to the Workers runtime.
 */

export async function buildWorker(
  { minify = true }: { minify?: boolean } = {},
) {
  const result = await Deno.bundle({
    entrypoints: [import.meta.resolve("../server/worker.ts")],
    outputPath: new URL("../cloudflare/dist/worker.js", import.meta.url)
      .pathname,
    platform: "browser",
    format: "esm",
    sourcemap: "linked",
    external: ["cloudflare:*"],
    minify,
    write: true,
  });
  if (!result.success) {
    throw new Error(
      "worker bundle failed:\n" +
        result.errors.map((e) => e.text).join("\n"),
    );
  }
  return result;
}

if (import.meta.main) {
  const result = await buildWorker();
  for (const w of result.warnings) console.warn("[bundler] warning", w.text);
  console.log("[bundler] worker complete");
}
