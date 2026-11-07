/**
 * Export home portal's production data into a SQL file for D1:
 *
 * 1. every domain table from Turso (libSQL), in foreign-key order;
 * 2. optionally, the Deno KV entries worth keeping (`--kv`): the RP signing
 *    key (so the IdP keeps trusting our client assertions under the same
 *    `kid`), recent emoji, and live DPoP sessions (so users stay signed in).
 *    Ephemeral state — invites, rate-limit windows, notification backoff,
 *    realtime signals — is not migrated.
 *
 * The output is data only (`INSERT`s, one per line): the D1 schema comes from
 * `cf d1 migrations apply` with the same migration files. Import it with
 * `import_d1.ts`.
 *
 * Usage (run with the old deployment stopped, so nothing changes after):
 *
 *   TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… \
 *   [DENO_KV_ACCESS_TOKEN=… ] \
 *   deno run -A scripts/export_data.ts [--kv <Deno KV URL or path>] \
 *     [--out migration-data/data.sql]
 */

import { parseArgs } from "@std/cli/parse-args";
import { encodeKey } from "@kuboon/kv/d1.ts";
import type { KvKeyPart } from "@kuboon/kv";

import { insertStatement, sqlLiteral, topoOrder } from "./sql_dump.ts";

/** Tables that are bookkeeping, not data. */
const SKIP_TABLES = new Set(["_migrations", "d1_migrations", "kv"]);

/** Deno KV top-level prefixes to carry over, with their TTL (ms) in D1. */
const KV_PREFIXES: Record<string, number | null> = {
  "rp_signing_key": null,
  "recent-emoji": null,
  "dpop-session": 3_600_000,
};

async function exportTurso(lines: string[]): Promise<Record<string, number>> {
  const url = Deno.env.get("TURSO_DATABASE_URL");
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  // `file:` (a local copy, e.g. for a rehearsal) needs the native client;
  // a hosted database is reached over HTTP.
  const { createClient } = url.startsWith("file:")
    ? await import("@libsql/client")
    : await import("@libsql/client/web");
  const client = createClient({
    url: url.replace(/^libsql:/, "https:"),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });

  const { rows: tableRows } = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  );
  const tables = tableRows.map((r) => String(r.name)).filter((t) =>
    !SKIP_TABLES.has(t)
  );

  const deps: Record<string, string[]> = {};
  for (const t of tables) {
    const { rows } = await client.execute({
      sql: 'SELECT "table" FROM pragma_foreign_key_list(?)',
      args: [t],
    });
    deps[t] = rows.map((r) => String(r.table));
  }

  const counts: Record<string, number> = {};
  for (const table of topoOrder(tables, deps)) {
    const { rows: cols } = await client.execute({
      sql: "SELECT name FROM pragma_table_info(?) ORDER BY cid",
      args: [table],
    });
    const columns = cols.map((c) => String(c.name));
    const { rows } = await client.execute(
      `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${table}" ` +
        "ORDER BY rowid",
    );
    lines.push(`-- ${table}: ${rows.length} rows`);
    for (const row of rows) {
      lines.push(insertStatement(table, columns, columns.map((c) => row[c])));
    }
    counts[table] = rows.length;
  }
  client.close();
  return counts;
}

async function exportKv(
  path: string,
  lines: string[],
): Promise<Record<string, number>> {
  const kv = await Deno.openKv(path);
  const counts: Record<string, number> = {};
  const now = Date.now();
  lines.push("-- kv (from Deno KV)");
  for (const [prefix, ttl] of Object.entries(KV_PREFIXES)) {
    counts[prefix] = 0;
    // `rp_signing_key` is a single key; the rest are prefixes.
    const entries = prefix === "rp_signing_key"
      ? [await kv.get([prefix])].filter((e) => e.value !== null)
      : await Array.fromAsync(kv.list({ prefix: [prefix] }));
    for (const entry of entries) {
      const key = encodeKey(entry.key as KvKeyPart[]);
      lines.push(
        "INSERT INTO kv (key, value, version, expires_at) VALUES (" +
          [
            sqlLiteral(key),
            sqlLiteral(JSON.stringify(entry.value)),
            "1",
            ttl === null ? "NULL" : String(now + ttl),
          ].join(", ") +
          ") ON CONFLICT (key) DO UPDATE SET value = excluded.value, " +
          "expires_at = excluded.expires_at;",
      );
      counts[prefix]++;
    }
  }
  kv.close();
  return counts;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["kv", "out"],
    default: { out: "migration-data/data.sql" },
  });
  const lines = [
    `-- home portal data export, ${new Date().toISOString()}`,
  ];
  const turso = await exportTurso(lines);
  console.log("[export] turso rows:", turso);
  if (args.kv) {
    const kv = await exportKv(args.kv, lines);
    console.log("[export] deno kv entries:", kv);
  }
  await Deno.mkdir(new URL(".", `file://${Deno.cwd()}/${args.out}`), {
    recursive: true,
  });
  await Deno.writeTextFile(args.out, lines.join("\n") + "\n");
  console.log(`[export] wrote ${args.out}`);
}
