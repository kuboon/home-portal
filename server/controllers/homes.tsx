/**
 * GET /homes — Home management page.
 *
 * Hosts the `HomesPanel` clientEntry, which loads/creates homes and manages
 * members over the DPoP-protected `/api/homes` endpoints. Rendered as a
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
        <h1 class="text-3xl font-bold">Home</h1>
        <p>
          家族・小グループの単位となる Home を作成し、メンバー（最大40人）と
          ロール（admin / member）を管理します。
        </p>
        <HomesPanel idpOrigin={idpOrigin} />
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.homes>;
