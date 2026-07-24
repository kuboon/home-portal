/**
 * GET /homes — the signed-in user's home list (hub).
 *
 * Hosts the `HomesPanel` clientEntry: list the homes you belong to (open one to
 * chat), create a home, or join by invite code. Per-home management lives
 * inside each home's settings, so this page stays a lean hub. Rendered as a
 * shell+frame on direct access and as a fragment in the content frame.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { HomesPanel } from "../../client/homes_panel.tsx";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

export const homesAction = {
  handler(context) {
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-3xl p-8 space-y-6">
        <h1 class="text-3xl font-bold">ホーム一覧</h1>
        <p class="opacity-70">
          参加しているホームを開いて会話します。新しいホームの作成や、招待
          コードでの参加もここから。
        </p>
        <HomesPanel idpOrigin={idpOrigin} />
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.homes>;
