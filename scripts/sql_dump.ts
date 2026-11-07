/**
 * Helpers shared by the data-migration scripts: SQL literal encoding,
 * foreign-key ordering, and chunking a dump for D1's query API.
 */

/**
 * Encode a value as a SQLite literal. Line breaks inside strings become
 * `char(10)` / `char(13)` concatenations so every statement stays on one
 * line (see {@link chunkStatements}).
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") {
    const parts = value.split(/(\r|\n)/).map((part) =>
      part === "\n"
        ? "char(10)"
        : part === "\r"
        ? "char(13)"
        : `'${part.replaceAll("'", "''")}'`
    ).filter((part, _i, all) => part !== "''" || all.length === 1);
    return parts.length > 1 ? `(${parts.join(" || ")})` : parts[0];
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `X'${bytes.toHex()}'`;
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

/** `INSERT INTO table (cols…) VALUES (…);` for one row. */
export function insertStatement(
  table: string,
  columns: string[],
  row: unknown[],
): string {
  const cols = columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
  return `INSERT INTO "${table}" (${cols}) VALUES (${
    row.map(sqlLiteral).join(", ")
  });`;
}

/**
 * Order tables so every table comes after the tables it references
 * (`deps[t]` = tables `t` has foreign keys to). Self-references are ignored;
 * cycles throw.
 */
export function topoOrder(
  tables: string[],
  deps: Record<string, string[]>,
): string[] {
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: string, path: string[]) => {
    if (state.get(t) === "done") return;
    if (state.get(t) === "visiting") {
      throw new Error(`foreign-key cycle: ${[...path, t].join(" → ")}`);
    }
    state.set(t, "visiting");
    for (const d of deps[t] ?? []) {
      if (d !== t && tables.includes(d)) visit(d, [...path, t]);
    }
    state.set(t, "done");
    out.push(t);
  };
  for (const t of [...tables].sort()) visit(t, []);
  return out;
}

/**
 * Split a dump (one statement per line, `--` comment lines allowed) into
 * chunks of at most `maxStatements` / `maxBytes`, each run as one D1 batch.
 */
export function chunkStatements(
  sql: string,
  { maxStatements = 100, maxBytes = 60_000 } = {},
): string[][] {
  const statements = sql.split("\n").map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("--")
  );
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const s of statements) {
    const bytes = new TextEncoder().encode(s).length + 1;
    if (
      current.length && (current.length >= maxStatements ||
        size + bytes > maxBytes)
    ) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
