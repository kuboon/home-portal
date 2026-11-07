/**
 * Minimal Cloudflare D1 REST client for the migration / CI scripts.
 *
 * Auth comes from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the same
 * variables the `cf` CLI reads), so everything runs unattended in GitHub
 * Actions.
 */

/** Overridable for testing against a local mock of the API. */
const API = Deno.env.get("CLOUDFLARE_API_BASE") ??
  "https://api.cloudflare.com/client/v4";

export const D1_NAME = "home-portal";

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export interface QueryResult {
  results: Record<string, unknown>[];
  success: boolean;
  meta?: { changes?: number };
}

function credentials(): { token: string; account: string } {
  const token = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const account = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  if (!token || !account) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set",
    );
  }
  return { token, account };
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { token, account } = credentials();
  const res = await fetch(`${API}/accounts/${account}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json() as Envelope<T>;
  if (!res.ok || !data.success) {
    const errors = (data.errors ?? []).map((e) => `${e.code} ${e.message}`);
    throw new Error(
      `Cloudflare API ${method} ${path} failed (${res.status}): ${
        errors.join("; ")
      }`,
    );
  }
  return data.result;
}

/** The id of the D1 database named `name`, or null. */
export async function findDatabase(name = D1_NAME): Promise<string | null> {
  const list = await call<{ uuid: string; name: string }[]>(
    "GET",
    `/d1/database?name=${encodeURIComponent(name)}`,
  );
  return list.find((d) => d.name === name)?.uuid ?? null;
}

/** Find the database, creating it (primary near `locationHint`) if absent. */
export async function ensureDatabase(
  name = D1_NAME,
  locationHint = "apac",
): Promise<{ id: string; created: boolean }> {
  const existing = await findDatabase(name);
  if (existing) return { id: existing, created: false };
  const created = await call<{ uuid: string }>("POST", "/d1/database", {
    name,
    primary_location_hint: locationHint,
  });
  return { id: created.uuid, created: true };
}

/** Run SQL (one or more `;`-separated statements) against a database. */
export function query(id: string, sql: string): Promise<QueryResult[]> {
  return call<QueryResult[]>("POST", `/d1/database/${id}/query`, { sql });
}

/** CLI: `deno run -A scripts/cloudflare_api.ts ensure|id [name]`. */
if (import.meta.main) {
  const [command, name = D1_NAME] = Deno.args;
  if (command === "ensure") {
    const { id, created } = await ensureDatabase(name);
    console.error(created ? `[d1] created ${name}` : `[d1] found ${name}`);
    console.log(id);
  } else if (command === "id") {
    const id = await findDatabase(name);
    if (!id) {
      console.error(`[d1] no database named ${name}`);
      Deno.exit(1);
    }
    console.log(id);
  } else {
    console.error("usage: cloudflare_api.ts ensure|id [name]");
    Deno.exit(2);
  }
}
