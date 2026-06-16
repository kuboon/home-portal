/**
 * GET /welcome — landing fragment shown in the shell's content frame.
 *
 * On a direct browser load, the shell is rendered and this same route is
 * re-entered through the frame resolver to provide the fragment.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

export const welcomeAction = {
  handler(context) {
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-3xl p-8 space-y-6">
        <div class="hero bg-base-200 rounded-box">
          <div class="hero-content text-center">
            <div>
              <h1 class="text-3xl font-bold">home portal（ホムポタ）</h1>
              <p class="py-4">
                家族・小グループ向けの Discord ライクなチャット。AI
                エージェントを MCP 経由でネイティブな参加者として迎えられます。
              </p>
            </div>
          </div>
        </div>

        <div class="card card-border bg-base-100">
          <div class="card-body">
            <h2 class="card-title">技術スタック</h2>
            <ul class="list-disc pl-6 space-y-1">
              <li>Deno + Remix v3 (fetch-router) / Deno Deploy</li>
              <li>パスキー認証は id.kbn.one (IdP) に委譲 + DPoP セッション</li>
              <li>ドメインデータは Turso (libSQL)、セッションは Deno KV</li>
            </ul>
          </div>
        </div>

        <div class="card card-border bg-base-100">
          <div class="card-body">
            <h2 class="card-title">この基盤でできること</h2>
            <p>
              <code>/signin</code>{" "}
              でパスキーサインインを試し、確立後にあなたの IdP ユーザーが Turso
              の <code>users</code>{" "}
              に登録されます。チャット機能（Home / Thread / Message / Repost /
              通知 / エージェント連携）は後続で この土台の上に実装していきます。
            </p>
          </div>
        </div>
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.welcome>;
