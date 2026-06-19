/**
 * GET /signin — passkey sign-in via id.kbn.one (IdP).
 *
 * Rendered as a shell+frame on direct access and as a fragment when loaded
 * via the shell's content frame. The status card is a `clientEntry`
 * (`SignInCard` in client/signin_card.tsx); the server emits its initial
 * HTML + a hydration marker, and the shell's `run()` hydrates it after
 * navigation — this works for both direct loads and frame swaps.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { SignInCard } from "../../client/signin_card.tsx";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

export const signinAction = {
  handler(context) {
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-3xl p-8 space-y-6">
        <meta name="idp-origin" content={idpOrigin} />
        <h1 class="text-3xl font-bold">パスキーでサインイン</h1>
        <p>パスキーで安全にサインインします。</p>

        <SignInCard idpOrigin={idpOrigin} />
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.signin>;
