/**
 * Minimal forward-only migration runner for the Turso (libSQL) database.
 *
 * Applies every `migrations/NNNN_*.sql` file (in lexical order) that has not
 * yet been recorded in the `_migrations` bookkeeping table. Each file runs as
 * a batch and is recorded by filename, so re-running is a no-op.
 *
 * Run with: `deno task --cwd packages/db migrate`
 */

import { db } from "./client.ts";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

async function appliedMigrations(): Promise<Set<string>> {
  const client = db();
  await client.execute(
    "CREATE TABLE IF NOT EXISTS _migrations (" +
      "name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const { rows } = await client.execute("SELECT name FROM _migrations");
  return new Set(rows.map((r) => String(r.name)));
}

function listMigrationFiles(): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  return names.sort();
}

/** Split a `.sql` file into individual statements (naive `;` splitter). */
function statements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

/** Apply all pending migrations. Returns the names that were applied. */
export async function migrate(): Promise<string[]> {
  const client = db();
  const done = await appliedMigrations();
  const applied: string[] = [];

  for (const name of listMigrationFiles()) {
    if (done.has(name)) continue;
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
    await client.batch(statements(sql), "write");
    await client.execute({
      sql: "INSERT INTO _migrations (name) VALUES (?)",
      args: [name],
    });
    applied.push(name);
    console.log(`[migrate] applied ${name}`);
  }

  if (applied.length === 0) console.log("[migrate] nothing to apply");
  return applied;
}

if (import.meta.main) {
  await migrate();
}
