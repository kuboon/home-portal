/**
 * A D1-shaped database over `node:sqlite`, for tests and the local Deno dev
 * server. D1 is SQLite underneath, so running the same SQL on a real SQLite
 * engine keeps behaviour (constraints, `RETURNING`, `ON CONFLICT`, …) honest
 * without a Workers runtime.
 *
 * Never import this from Worker code: `node:sqlite` does not exist there.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type Row,
  setDatabase,
} from "./client.ts";

export type SqliteD1 = D1DatabaseLike & { close(): void };

/** Open `path` (default `:memory:`) as a {@link D1DatabaseLike}. */
export function openSqliteD1(path = ":memory:"): SqliteD1 {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");

  const statement = (sql: string, args: unknown[]): D1PreparedStatementLike & {
    exec(): { results: Row[]; meta: { changes: number } };
  } => {
    const exec = () => {
      const prepared = sqlite.prepare(sql);
      const values = args as SQLInputValue[];
      if (prepared.columns().length > 0) {
        // A query, or DML with RETURNING.
        const results = prepared.all(...values) as Row[];
        const changes = Number(
          (sqlite.prepare("SELECT changes() AS n").get() as { n: number }).n,
        );
        const isQuery = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql);
        return { results, meta: { changes: isQuery ? 0 : changes } };
      }
      const res = prepared.run(...values);
      return { results: [], meta: { changes: Number(res.changes) } };
    };
    return {
      exec,
      bind: (...values: unknown[]) => statement(sql, values),
      first<T>() {
        return Promise.resolve((exec().results[0] ?? null) as T | null);
      },
      all<T>() {
        const res = exec();
        return Promise.resolve(
          res as { results: T[]; meta: { changes: number } },
        );
      },
      run() {
        return Promise.resolve({ meta: exec().meta });
      },
    };
  };

  return {
    prepare: (sql) => statement(sql, []),
    batch(statements) {
      // D1 runs a batch as one transaction; mirror that.
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) =>
          (s as ReturnType<typeof statement>).exec()
        );
        sqlite.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        sqlite.exec("ROLLBACK");
        return Promise.reject(error);
      }
    },
    close: () => sqlite.close(),
  };
}

let current: SqliteD1 | undefined;

/**
 * Install a fresh in-memory database as the process-wide one (tests). Call
 * `migrate()` afterwards to create the schema.
 */
export function resetClient(): SqliteD1 {
  current?.close();
  current = openSqliteD1();
  setDatabase(current);
  return current;
}
