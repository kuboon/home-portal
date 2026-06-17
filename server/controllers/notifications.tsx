/**
 * GET /notifications — Web Push device management.
 *
 * Hosts the `NotificationsCard` clientEntry, which manages push subscriptions
 * via the IdP (id.kbn.one) push API. The service worker is served at /sw.js.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { NotificationsCard } from "../../client/notifications_card.tsx";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

export const notificationsAction = {
  handler(context) {
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-3xl p-8 space-y-6">
        <h1 class="text-3xl font-bold">通知</h1>
        <p>
          Web Push 通知の端末登録を管理します。認証と同じく id.kbn.one (IdP) の
          push API に委譲し、通知はこの端末のサービスワーカーで受け取ります。
        </p>
        <NotificationsCard idpOrigin={idpOrigin} />
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.notifications>;
