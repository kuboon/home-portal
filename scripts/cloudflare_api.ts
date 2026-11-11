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

/** The Worker's name (`cloudflare/cloudflare.config.ts`). */
export const WORKER_NAME = "home-portal";

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

/**
 * Probe what the token can reach, so a 403 from `cf deploy` can be traced to
 * a missing permission. Read-only: every call is a GET. Returns the lines of
 * a Markdown table and whether every probe passed.
 */
export async function checkToken(): Promise<{ ok: boolean; lines: string[] }> {
  const { token, account } = credentials();
  const probes: [string, string][] = [
    ["token (user-owned)", "/user/tokens/verify"],
    ["token (account-owned)", `/accounts/${account}/tokens/verify`],
    ["Workers Scripts", `/accounts/${account}/workers/scripts`],
    ["workers.dev subdomain", `/accounts/${account}/workers/subdomain`],
    [
      "Durable Objects",
      `/accounts/${account}/workers/durable_objects/namespaces`,
    ],
    ["D1", `/accounts/${account}/d1/database`],
  ];
  // The one write `cf deploy` failed on (403): opening an asset upload
  // session. With an empty manifest nothing is uploaded or created; any
  // answer other than 401/403 means the token may write Workers scripts.
  const writeProbe: [string, string, RequestInit] = [
    "Workers Scripts (write: asset upload session)",
    `/accounts/${account}/workers/scripts/${WORKER_NAME}/assets-upload-session`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: {} }),
    },
  ];
  const lines = ["| API | status | |", "| --- | --- | --- |"];
  const results: Record<string, boolean> = {};
  for (
    const [label, path, init] of [
      ...probes.map(([l, p]) => [l, p, {}] as [string, string, RequestInit]),
      writeProbe,
    ]
  ) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({})) as Envelope<unknown>;
    const ok = init.method === "POST"
      ? res.status !== 401 && res.status !== 403
      : res.ok && data.success !== false;
    results[label] = ok;
    const error = (data.errors ?? []).map((e) => `${e.code} ${e.message}`)
      .join("; ");
    lines.push(`| ${label} | ${res.status} | ${ok ? "✅" : `❌ ${error}`} |`);
  }
  // Exactly one of the two verify endpoints applies to a given token.
  const tokenOk = results["token (user-owned)"] ||
    results["token (account-owned)"];
  const ok = tokenOk &&
    Object.entries(results).every(([k, v]) => k.startsWith("token") || v);
  return { ok, lines };
}

/** CLI: `deno run -A scripts/cloudflare_api.ts ensure|id|check [name]`. */
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
  } else if (command === "check") {
    const { ok, lines } = await checkToken();
    const table = ["### Cloudflare API token", "", ...lines, ""].join("\n");
    console.log(table);
    const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
    if (summary) await Deno.writeTextFile(summary, table, { append: true });
    if (!ok) {
      console.error(
        "[check] the token cannot reach every API the deploy needs",
      );
      Deno.exit(1);
    }
  } else {
    console.error("usage: cloudflare_api.ts ensure|id|check [name]");
    Deno.exit(2);
  }
}
