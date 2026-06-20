/**
 * home portal (ホムポタ) server — Remix v3 + Deno + DPoP session middleware.
 *
 * Route definitions live in `./routes.ts`; each page/endpoint has a
 * controller under `./controllers/`. This module wires global middleware
 * (static files) and maps routes to controllers. Run with `deno serve`.
 */

import { createRouter, type Middleware } from "@remix-run/fetch-router";
import { staticFiles } from "@remix-run/static-middleware";

import { agentsController } from "./controllers/api/agents.ts";
import { apiController } from "./controllers/api/controller.ts";
import { homesController } from "./controllers/api/homes.ts";
import { invitesController } from "./controllers/api/invites.ts";
import { threadsController } from "./controllers/api/threads.ts";
import { agentsAction } from "./controllers/agents.tsx";
import { homeChatAction, homeThreadAction } from "./controllers/chat.tsx";
import { homeAction } from "./controllers/home.tsx";
import { homesAction } from "./controllers/homes.tsx";
import { jwksAction } from "./controllers/jwks.ts";
import { mcpAction } from "./controllers/mcp.ts";
import { notificationsAction } from "./controllers/notifications.tsx";
import { signinAction } from "./controllers/signin.tsx";
import { welcomeAction } from "./controllers/welcome.tsx";
import { routes } from "./routes.ts";

const kvAccessToken = Deno.env.get("KV_ACCESS_TOKEN");
if (kvAccessToken) Deno.env.set("DENO_KV_ACCESS_TOKEN", kvAccessToken);

// The IdP origin must be reachable for the browser's DPoP `fetch` (sign-in,
// session, logout); everything else is same-origin.
const IDP_ORIGIN = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

// Content-Security-Policy is the defence-in-depth partner the theme sanitizer
// (server/theme.ts) relies on: even if a crafted theme slipped past, `url()`
// fetches and inline scripts have nowhere to go. `style-src 'unsafe-inline'`
// is required because home themes are injected as an inline <style>.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self' ${IDP_ORIGIN}`,
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

const router = createRouter({
  middleware: [
    securityHeaders,
    staticFiles(new URL("./bundled", import.meta.url).pathname),
  ],
});

router.get(routes.home, homeAction);
router.get(routes.welcome, welcomeAction);
router.get(routes.signin, signinAction);
router.get(routes.homes, homesAction);
router.get(routes.homeChat, homeChatAction);
router.get(routes.homeThread, homeThreadAction);
router.get(routes.agents, agentsAction);
router.get(routes.notifications, notificationsAction);
router.get(routes.jwks, jwksAction);
router.post(routes.mcp, mcpAction);
router.map(routes.api, apiController);
router.map(routes.agentsApi, agentsController);
router.map(routes.homesApi, homesController);
router.map(routes.invitesApi, invitesController);
router.map(routes.threadsApi, threadsController);

export default router;
