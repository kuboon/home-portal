/**
 * home portal (ホムポタ) server — Remix v3 + DPoP session middleware.
 *
 * Route definitions live in `./routes.ts`; each page/endpoint has a
 * controller under `./controllers/`. This module wires global middleware
 * and maps routes to controllers. It is runtime-neutral: the entrypoints
 * install the database / realtime hub and decide how static files are served
 * (`./worker.ts` on Cloudflare Workers — static assets are served by the
 * platform before the Worker runs; `./dev.ts` for local `deno serve`).
 */

import { createRouter, type Middleware } from "@remix-run/fetch-router";

import { agentsController } from "./controllers/api/agents.ts";
import { apiController } from "./controllers/api/controller.ts";
import { homesController } from "./controllers/api/homes.ts";
import { invitesController } from "./controllers/api/invites.ts";
import { stampsController } from "./controllers/api/stamps.ts";
import { threadsController } from "./controllers/api/threads.ts";
import { agentsAction } from "./controllers/agents.tsx";
import {
  homeChatAction,
  homeManifestAction,
  homeThreadAction,
} from "./controllers/chat.tsx";
import { homeAction } from "./controllers/home.tsx";
import { homesAction } from "./controllers/homes.tsx";
import { joinAction } from "./controllers/join.tsx";
import { jwksAction } from "./controllers/jwks.ts";
import { mcpAction, mcpAgentAction } from "./controllers/mcp.ts";
import { mcpResourceMetadataAction } from "./controllers/oauth_resource.ts";
import { notificationsAction } from "./controllers/notifications.tsx";
import { signinAction } from "./controllers/signin.tsx";
import { welcomeAction } from "./controllers/welcome.tsx";
import { IDP_ORIGIN, STORAGE_ORIGIN } from "./config.ts";
import { routes } from "./routes.ts";

// The IdP origin must be reachable for the browser's DPoP `fetch` (sign-in,
// session, logout). The storage origin hosts stamp images: the browser
// uploads to and downloads from it directly (DPoP-authenticated fetch), and
// renders the bytes via blob: URLs. Everything else is same-origin.

// Content-Security-Policy is the defence-in-depth partner the theme sanitizer
// (server/theme.ts) relies on: even if a crafted theme slipped past, `url()`
// fetches and inline scripts have nowhere to go. `style-src 'unsafe-inline'`
// is required because home themes are injected as an inline <style>.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${IDP_ORIGIN} ${STORAGE_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

/** Add baseline security headers to every response. */
const securityHeaders: Middleware = async (_context, next) => {
  const response = await next();
  const headers = response.headers;
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
};

/**
 * Build the app router. `extra` middleware runs after the security headers
 * and before routing (the dev server passes its static-file handler here).
 */
export function createAppRouter(extra: Middleware[] = []) {
  const router = createRouter({ middleware: [securityHeaders, ...extra] });

  router.get(routes.home, homeAction);
  router.get(routes.welcome, welcomeAction);
  router.get(routes.signin, signinAction);
  router.get(routes.homes, homesAction);
  router.get(routes.homeChat, homeChatAction);
  router.get(routes.homeThread, homeThreadAction);
  router.get(routes.homeManifest, homeManifestAction);
  router.get(routes.join, joinAction);
  router.get(routes.agents, agentsAction);
  router.get(routes.notifications, notificationsAction);
  router.get(routes.jwks, jwksAction);
  router.get(routes.mcpResourceMetadata, mcpResourceMetadataAction);
  router.post(routes.mcpAgent, mcpAgentAction);
  router.post(routes.mcp, mcpAction);
  router.map(routes.api, apiController);
  router.map(routes.agentsApi, agentsController);
  router.map(routes.homesApi, homesController);
  router.map(routes.invitesApi, invitesController);
  router.map(routes.stampsApi, stampsController);
  router.map(routes.threadsApi, threadsController);
  return router;
}
