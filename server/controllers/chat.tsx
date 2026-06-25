/**
 * GET /home/:homeId and /home/:homeId/thread/:threadId — the chat view.
 *
 * Hosts the `ChatPanel` clientEntry (sidebar of threads + a conversation pane)
 * for one home. The home and thread ids come from the URL; everything else is
 * loaded client-side over the DPoP-protected `/api` endpoints. Rendered as a
 * shell+frame on direct access and as a fragment in the content frame.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { ChatPanel } from "../../client/chat_panel.tsx";
import type { routes } from "../routes.ts";
import { renderBareDocument } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

function chatPage(homeId: string, threadId: string) {
  return renderBareDocument(
    "home portal (ホムポタ)",
    <ChatPanel idpOrigin={idpOrigin} homeId={homeId} threadId={threadId} />,
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
