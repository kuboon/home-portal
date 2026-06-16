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
  const client = await db();
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

/**
 * Split a `.sql` file into individual statements: strip whole-line `--`
 * comments first (so a leading comment block doesn't swallow the statement
 * that follows it), then split on `;`.
 */
function statements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Apply all pending migrations. Returns the names that were applied. */
export async function migrate(): Promise<string[]> {
  const client = await db();
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
