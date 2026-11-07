/**
 * Build home portal for Cloudflare Workers into the Build Output
 * Specification tree that `cf deploy --prebuilt` uploads:
 *
 * 1. client JS/CSS + service worker → `server/bundled/` (as for dev);
 * 2. `server/worker.ts` → `cloudflare/dist/worker.js` (`Deno.bundle`);
 * 3. `cf build` in `cloudflare/` → `.cloudflare/output/v0/workers/default/`
 *    (worker bundle + `worker.config.json` from `cloudflare.config.ts`);
 * 4. copy `server/bundled/` (+ a `_headers` file) into that Worker's
 *    `assets/`, which `cf` cannot be told about for a non-Vite Worker.
 *
 * Needs `npm ci` in `cloudflare/` first (for the `cf` CLI).
 */

import { buildCss, buildJs, copyAssets } from "./mod.ts";
import { buildWorker } from "./worker.ts";

const CLOUDFLARE_DIR = new URL("../cloudflare/", import.meta.url);
const ASSETS_SRC = new URL("../server/bundled/", import.meta.url);
const ASSETS_OUT = new URL(
  ".cloudflare/output/v0/workers/default/assets/",
  CLOUDFLARE_DIR,
);

/**
 * Headers for static assets (Workers Static Assets `_headers` syntax). The
 * Worker sets its own security headers on dynamic responses.
 */
const HEADERS_FILE = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`;

async function run(cmd: string, args: string[], cwd: URL): Promise<void> {
  const { code } = await new Deno.Command(cmd, {
    args,
    cwd: cwd.pathname,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
}

async function copyDir(from: URL, to: URL): Promise<number> {
  await Deno.mkdir(to, { recursive: true });
  let n = 0;
  for await (const entry of Deno.readDir(from)) {
    const src = new URL(entry.name, from);
    if (entry.isDirectory) {
      n += await copyDir(
        new URL(`${entry.name}/`, from),
        new URL(`${entry.name}/`, to),
      );
    } else if (entry.isFile) {
      await Deno.copyFile(src, new URL(entry.name, to));
      n++;
    }
  }
  return n;
}

if (import.meta.main) {
  await Promise.all([buildJs(), buildCss(), copyAssets()]);
  console.log("[cloudflare] client assets built");
  await buildWorker();
  console.log("[cloudflare] worker bundled");
  await run("npx", ["cf", "build"], CLOUDFLARE_DIR);
  const n = await copyDir(ASSETS_SRC, ASSETS_OUT);
  await Deno.writeTextFile(new URL("_headers", ASSETS_OUT), HEADERS_FILE);
  console.log(`[cloudflare] copied ${n} assets into the build output`);
}
