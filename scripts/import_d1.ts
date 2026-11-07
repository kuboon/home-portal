/**
 * Import a data dump from `export_data.ts` into Cloudflare D1, then verify
 * that every table has the row count the export recorded.
 *
 * Goes through the D1 REST API (`CLOUDFLARE_API_TOKEN` +
 * `CLOUDFLARE_ACCOUNT_ID`), in batches of up to 100 statements. Refuses to
 * run unless the target is empty (no users), so a re-run can't duplicate or
 * half-overwrite data. Writes a summary table to `$GITHUB_STEP_SUMMARY` when
 * run in GitHub Actions (the `cloudflare` workflow's `import-data` step).
 *
 *   deno run -A scripts/import_d1.ts [migration-data/data.sql]
 */

import { D1_NAME, findDatabase, query } from "./cloudflare_api.ts";
import { chunkStatements } from "./sql_dump.ts";

async function count(id: string, table: string): Promise<number> {
  const [res] = await query(id, `SELECT count(*) AS n FROM "${table}"`);
  return Number(res.results[0]?.n ?? 0);
}

if (import.meta.main) {
  const file = Deno.args[0] ?? "migration-data/data.sql";
  const expected = JSON.parse(
    await Deno.readTextFile(`${file}.counts.json`),
  ) as Record<string, number>;

  const id = await findDatabase(D1_NAME);
  if (!id) throw new Error(`no D1 database named ${D1_NAME} (run setup)`);

  const existingUsers = await count(id, "users");
  if (existingUsers > 0) {
    throw new Error(
      `D1 ${D1_NAME} already has ${existingUsers} users; refusing to import ` +
        "into a non-empty database",
    );
  }

  const chunks = chunkStatements(await Deno.readTextFile(file));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  console.log(`[import] ${total} statements in ${chunks.length} batches`);
  for (const [i, chunk] of chunks.entries()) {
    // The dump is in foreign-key order; deferring just tolerates order
    // within a batch.
    await query(id, ["PRAGMA defer_foreign_keys = true;", ...chunk].join("\n"));
    console.log(`[import] batch ${i + 1}/${chunks.length} ok`);
  }

  const rows: string[] = [];
  let mismatches = 0;
  for (const [table, want] of Object.entries(expected)) {
    const got = await count(id, table);
    if (got !== want) mismatches++;
    rows.push(
      `| ${table} | ${want} | ${got} | ${got === want ? "✅" : "❌"} |`,
    );
  }
  const kvRows = await count(id, "kv");
  const summary = [
    `### D1 import (${D1_NAME})`,
    "",
    "| table | Turso | D1 | |",
    "| --- | ---: | ---: | --- |",
    ...rows,
    "",
    `kv rows (from Deno KV): ${kvRows}`,
    "",
  ].join("\n");
  console.log(summary);
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    await Deno.writeTextFile(summaryFile, summary, { append: true });
  }

  if (mismatches > 0) {
    throw new Error(`${mismatches} table(s) have mismatched row counts`);
  }
  console.log("[import] done, all counts match");
}
