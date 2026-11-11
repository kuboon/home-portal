/**
 * Local development server (`deno serve`), standing in for the Workers
 * runtime:
 *
 * - D1 → a `node:sqlite` file (`DEV_DB_PATH`, default `.local/dev.sqlite`),
 *   migrated on startup;
 * - Durable Object realtime hub → the in-process hub (default);
 * - Workers Static Assets → `staticFiles` over `server/bundled/`.
 *
 * Production runs `./worker.ts` on Cloudflare; see `cloudflare/README.md`.
 */

import { staticFiles } from "@remix-run/static-middleware";
import { setDatabase } from "@scope/db";
import { migrate } from "@scope/db/migrate.ts";
import { openSqliteD1 } from "@scope/db/sqlite.ts";

import { createAppRouter } from "./router.ts";

const path = Deno.env.get("DEV_DB_PATH") ??
  new URL("../.local/dev.sqlite", import.meta.url).pathname;
await Deno.mkdir(new URL(".", `file://${path}`), { recursive: true });
setDatabase(openSqliteD1(path));
const applied = await migrate();
if (applied.length) console.log(`[dev] migrated ${path}:`, applied.join(", "));

export default createAppRouter([
  staticFiles(new URL("./bundled", import.meta.url).pathname),
]);
