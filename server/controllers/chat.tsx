/**
 * GET /home/:homeId and /home/:homeId/thread/:threadId — the chat view.
 *
 * Hosts the `ChatPanel` clientEntry (sidebar of threads + a conversation pane)
 * for one home. The home and thread ids come from the URL; everything else is
 * loaded client-side over the DPoP-protected `/api` endpoints. Rendered as a
 * shell+frame on direct access and as a fragment in the content frame.
 *
 * The document is titled with the home name so an iOS/Android "add to home
 * screen" (A2HS) icon is labelled with it; Android additionally reads the
 * per-home `manifest.webmanifest` served by `homeManifestAction`.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { getHome } from "@scope/db";
import { ChatPanel } from "../../client/chat_panel.tsx";
import type { routes } from "../routes.ts";
import { renderBareDocument } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";
const DEFAULT_TITLE = "home portal (ホムポタ)";

async function chatPage(homeId: string, threadId: string): Promise<Response> {
  const home = await getHome(homeId);
  const title = home?.name ?? DEFAULT_TITLE;
  return renderBareDocument(
    title,
    <ChatPanel idpOrigin={idpOrigin} homeId={homeId} threadId={threadId} />,
    <link
      rel="manifest"
      href={`/home/${encodeURIComponent(homeId)}/manifest.webmanifest`}
    />,
  );
}

export const homeChatAction = {
  handler(context) {
    return chatPage(context.params.homeId, "");
  },
} satisfies BuildAction<"GET", typeof routes.homeChat>;

export const homeThreadAction = {
  handler(context) {
    const { homeId, threadId } = context.params;
    return chatPage(homeId, threadId);
  },
} satisfies BuildAction<"GET", typeof routes.homeThread>;

/**
 * GET /home/:homeId/manifest.webmanifest — a per-home PWA manifest so that an
 * "add to home screen" icon (Android/Chrome) is named after the home and opens
 * scoped to `/home/:homeId`. iOS uses the `apple-mobile-web-app-title` meta.
 */
export const homeManifestAction = {
  async handler(context) {
    const { homeId } = context.params;
    const home = await getHome(homeId);
    const name = home?.name ?? DEFAULT_TITLE;
    const start = `/home/${encodeURIComponent(homeId)}`;
    const manifest = {
      name,
      short_name: name,
      start_url: start,
      scope: start,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
    };
    return new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
    });
  },
} satisfies BuildAction<"GET", typeof routes.homeManifest>;
