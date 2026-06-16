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
        <p>
          認証は外部 IdP (<code>{idpOrigin}</code>){" "}
          に委譲します。ブラウザで DPoP 鍵を生成し、その thumbprint を IdP に
          bind してもらうことで Cookie レスにセッションを共有します。サインイン
          が確立すると、あなたの userId が home portal の Turso{" "}
          <code>users</code> に登録されます。
        </p>

        <SignInCard idpOrigin={idpOrigin} />

        <div class="card card-border bg-base-100">
          <div class="card-body">
            <h2 class="card-title">仕組み</h2>
            <ol class="list-decimal pl-6 space-y-1">
              <li>
                このページが DPoP <code>thumbprint</code> を計算
              </li>
              <li>
                「サインイン」で <code>{idpOrigin}/authorize</code>{" "}
                へ遷移し IdP がパスキー認証
              </li>
              <li>
                IdP が thumbprint に userId を bind → 戻って{" "}
                <code>{idpOrigin}/session</code> が userId を返す
              </li>
              <li>
                home portal の <code>POST /api/users/sync</code> (DPoP 保護)
                {" "}
                が Turso にユーザーを upsert
              </li>
            </ol>
          </div>
        </div>
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.signin>;
