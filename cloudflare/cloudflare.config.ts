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
    // Run in Tokyo, next to the users and the D1 primary (created with the
    // `apac` location hint): most requests make several D1 round trips.
    placement: { region: "aws:ap-northeast-1" },
    observability: { enabled: true },
    domains: domain ? [domain] : undefined,
    // workers.dev only until cutover; once on the custom domain it stays off
    // (it was switched off in the dashboard, and `cf deploy` in CI aborts when
    // the local config disagrees with the remote one).
    workersDev: !domain,
    // Version preview URLs stay on, as set in the dashboard. Left unset, `cf`
    // derives `false` from `workersDev: false`, which `cf deploy` counts as a
    // conflicting change and aborts.
    previewUrls: true,
    // Hourly: sweep expired KV rows (D1 has no TTL).
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    exports: {
      ChannelHub: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      // The id pins the existing database (created by the workflow's `setup`).
      // Without it, `cf deploy` reads the binding as dropping the remote
      // `database_id` and aborts when the Worker was last changed in the
      // dashboard.
      DB: bindings.d1({
        name: "home-portal",
        id: "c678afa4-f8ac-4e15-8607-9f432f3648bd",
      }),
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
