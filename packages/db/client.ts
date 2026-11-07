/**
 * Cloudflare D1 client for home portal.
 *
 * The data layer talks to a tiny libSQL-shaped facade ({@link SqlClient}:
 * `execute` / `batch` returning `{ rows, rowsAffected }`) so table modules stay
 * backend-agnostic. In production the facade wraps the Worker's D1 binding
 * (`env.DB`); tests and the local Deno dev server wrap a `node:sqlite`
 * database through the same D1-shaped interface (see `./sqlite.ts`), so the
 * SQL always runs on a real SQLite engine.
 *
 * Bindings only exist inside a request on Workers, so the database is
 * installed with {@link setDatabase} by the entrypoint (`server/worker.ts`,
 * `server/dev.ts`) and resolved lazily on each query.
 */

/** A value that can be bound to a statement parameter. */
export type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | ArrayBuffer;

/** A statement: bare SQL, or SQL with positional `?` arguments. */
export type Statement = string | { sql: string; args?: SqlValue[] };

/** A row keyed by column name. */
export type Row = Record<string, unknown>;

export interface ResultSet {
  rows: Row[];
  /** Rows changed by an INSERT/UPDATE/DELETE (0 for queries). */
  rowsAffected: number;
}

/** The query surface the table modules use. */
export interface SqlClient {
  execute(statement: Statement): Promise<ResultSet>;
  /** Run statements atomically (one implicit transaction). */
  batch(statements: Statement[], mode?: "write" | "read"): Promise<ResultSet[]>;
}

/** The subset of Cloudflare's `D1PreparedStatement` we rely on. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[]; meta?: { changes?: number } }>;
  run(): Promise<{ meta: { changes: number } }>;
}

/** The subset of Cloudflare's `D1Database` we rely on. */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(
    statements: D1PreparedStatementLike[],
  ): Promise<{ results?: unknown[]; meta?: { changes?: number } }[]>;
}

/** D1 accepts booleans, but normalise them (and `undefined`) like libSQL did. */
const normalise = (value: SqlValue | undefined): unknown =>
  value === undefined
    ? null
    : typeof value === "boolean"
    ? (value ? 1 : 0)
    : value;

const toStatement = (statement: Statement) =>
  typeof statement === "string" ? { sql: statement, args: [] } : {
    sql: statement.sql,
    args: statement.args ?? [],
  };

/** Wrap a D1 binding (or a D1-shaped stand-in) as a {@link SqlClient}. */
export function d1Client(d1: D1DatabaseLike): SqlClient {
  const prepare = (statement: Statement) => {
    const { sql, args } = toStatement(statement);
    const prepared = d1.prepare(sql);
    return args.length ? prepared.bind(...args.map(normalise)) : prepared;
  };
  const toResult = (
    res: { results?: unknown[]; meta?: { changes?: number } },
  ): ResultSet => ({
    rows: (res.results ?? []) as Row[],
    rowsAffected: Number(res.meta?.changes ?? 0),
  });

  return {
    async execute(statement) {
      return toResult(await prepare(statement).all());
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      const results = await d1.batch(statements.map(prepare));
      return results.map(toResult);
    },
  };
}

let resolveD1: (() => D1DatabaseLike) | undefined;
let cached: { d1: D1DatabaseLike; client: SqlClient } | undefined;

/**
 * Install the database. Pass a getter on Workers (the binding is per-request
 * `env`), or the database itself for tests / local dev.
 */
export function setDatabase(
  database: D1DatabaseLike | (() => D1DatabaseLike),
): void {
  resolveD1 = typeof database === "function" ? database : () => database;
  cached = undefined;
}

/** The raw D1 database (for modules that speak D1 directly, e.g. KV). */
export function getD1(): D1DatabaseLike {
  if (!resolveD1) {
    throw new Error(
      "No database installed. Workers: bind D1 as `DB`; tests/dev: call " +
        "setDatabase() (see packages/db/sqlite.ts).",
    );
  }
  return resolveD1();
}

/** The process-wide client over the installed database. */
export function db(): Promise<SqlClient> {
  const d1 = getD1();
  if (cached?.d1 !== d1) cached = { d1, client: d1Client(d1) };
  return Promise.resolve(cached.client);
}
