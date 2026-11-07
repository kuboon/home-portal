/**
 * Import a data dump from `export_data.ts` into Cloudflare D1, in batches,
 * through the `cf` CLI (`cf d1 query <id> --sql …`, one transaction per
 * batch). Uses whatever auth `cf` has (`cf auth login`, or
 * `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).
 *
 * Run `cf d1 migrations apply` first so the schema exists, and import into an
 * empty database (re-running would hit primary-key conflicts on domain rows).
 *
 *   deno run -A scripts/import_d1.ts <D1 database id> [migration-data/data.sql]
 */

import { chunkStatements } from "./sql_dump.ts";

const CLOUDFLARE_DIR = new URL("../cloudflare/", import.meta.url);

async function query(databaseId: string, sql: string): Promise<void> {
  const { code, stdout, stderr } = await new Deno.Command("npx", {
    args: ["cf", "d1", "query", databaseId, "--sql", sql],
    cwd: CLOUDFLARE_DIR.pathname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    const decoder = new TextDecoder();
    throw new Error(
      `cf d1 query failed (${code}):\n${decoder.decode(stderr)}\n${
        decoder.decode(stdout)
      }`,
    );
  }
}

if (import.meta.main) {
  const [databaseId, file = "migration-data/data.sql"] = Deno.args;
  if (!databaseId) {
    console.error("usage: import_d1.ts <D1 database id> [dump.sql]");
    Deno.exit(2);
  }
  const chunks = chunkStatements(await Deno.readTextFile(file));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  console.log(`[import] ${total} statements in ${chunks.length} batches`);
  for (const [i, chunk] of chunks.entries()) {
    // Foreign keys are checked at each batch's commit; the dump is already
    // in dependency order, deferring just tolerates order within a batch.
    await query(
      databaseId,
      ["PRAGMA defer_foreign_keys = true;", ...chunk].join("\n"),
    );
    console.log(`[import] batch ${i + 1}/${chunks.length} ok`);
  }
  console.log("[import] done");
}
