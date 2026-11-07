/**
 * Cloudflare Workers config for home portal (read by the `cf` CLI).
 *
 * The Worker entrypoint is the Deno-built bundle `dist/worker.js` (from
 * `server/worker.ts`, see `bundler/worker.ts`). Static assets are not
 * declared here: `cf`'s config has no assets directory for a non-Vite
 * Worker, so `bundler/cloudflare.ts` copies `server/bundled/` into the Build
 * Output (`.cloudflare/output/v0/workers/default/assets`) after `cf build`,
 * and `cf deploy --prebuilt` uploads it. Assets are served before the Worker.
 */

import { bindings, defineConfig, exports, triggers } from "cf/config";

const WORKER_NAME = "home-portal";

/**
 * Custom domain to attach on deploy (e.g. `home.kbn.one`). Left unset until
 * cutover so a deploy never takes over the domain still served by the old
 * deployment; set `HOME_PORTAL_DOMAIN` in the deploy environment to attach.
 */
const domain = process.env.HOME_PORTAL_DOMAIN;

export default defineConfig({
  worker: {
    name: WORKER_NAME,
    compatibilityDate: "2026-11-01",
    // nodejs_compat populates `process.env` from the text vars below
    // (server/config.ts reads them there).
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./dist/worker.js",
    // Most requests make several D1 round trips: run next to the database.
    placement: { mode: "smart" },
    observability: { enabled: true },
    domains: domain ? [domain] : undefined,
    // Hourly: sweep expired KV rows (D1 has no TTL).
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    exports: {
      ChannelHub: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      DB: bindings.d1({ name: "home-portal" }),
      CHANNEL_HUB: bindings.durableObject({
        worker: WORKER_NAME,
        exportName: "ChannelHub",
      }),
      IDP_ORIGIN: bindings.text("https://id.kbn.one"),
      RP_ORIGIN: bindings.text(
        domain ? `https://${domain}` : "https://home.kbn.one",
      ),
      STORAGE_ORIGIN: bindings.text("https://storage.kbn.one"),
    },
  },
});
