/**
 * GET /join/:token — the public invite landing page.
 *
 * Anyone with a live invite link lands here. The page hosts the `JoinPanel`
 * clientEntry, which drives the passkey sign-in/sign-up (via id.kbn.one) and
 * then redeems the token (`POST /api/invites/:token/accept`) to join the home,
 * finally redirecting to the chat view. The token's home name is resolved
 * server-side so the invitee sees which home they're joining before signing in
 * (the token grants that home already, so this leaks nothing new).
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { getHome } from "@scope/db";
import { JoinPanel } from "../../client/join_panel.tsx";
import type { routes } from "../routes.ts";
import { resolveInvite } from "../invites.ts";
import { renderBareDocument } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

export const joinAction = {
  async handler(context) {
    const { token } = context.params;
    const homeId = await resolveInvite(token);
    const home = homeId ? await getHome(homeId) : null;
    const title = home ? `${home.name} に参加` : "招待";
    return renderBareDocument(
      title,
      <JoinPanel
        idpOrigin={idpOrigin}
        token={token}
        homeName={home?.name ?? ""}
        valid={home != null}
      />,
    );
  },
} satisfies BuildAction<"GET", typeof routes.join>;
