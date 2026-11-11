/**
 * Runtime configuration from environment variables.
 *
 * Read through `process.env`, which both runtimes provide: Deno exposes it
 * natively, and Workers populate it from the Worker's text vars and secrets
 * (`nodejs_compat`, compatibility date ≥ 2025-04-01) before the module is
 * evaluated, so top-level reads work. Bindings (D1, Durable Objects) are not
 * strings and are installed by the entrypoint instead.
 */

const read = (name: string): string | undefined =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name] || undefined;

/** The IdP origin (passkey sign-in, push, OAuth for MCP). */
export const IDP_ORIGIN: string = read("IDP_ORIGIN") ?? "https://id.kbn.one";

/** This app's own origin (client-assertion iss/sub, JWKS issuer). */
export const RP_ORIGIN: string = read("RP_ORIGIN") ?? "https://home.kbn.one";

/** storage.kbn.one origin (stamp / image uploads from the browser). */
export const STORAGE_ORIGIN: string = read("STORAGE_ORIGIN") ??
  "https://storage.kbn.one";
