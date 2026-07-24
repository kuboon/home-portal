/**
 * GET /welcome — the public landing fragment shown in the shell's content
 * frame. It introduces the product to a general (signed-out) visitor; the only
 * action is to sign in, which leads to the home list (`/homes`). All actual
 * settings live inside each home, so the landing stays a plain feature intro.
 *
 * On a direct browser load, the shell is rendered and this same route is
 * re-entered through the frame resolver to provide the fragment.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { RemixNode } from "@remix-run/ui";
import { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

/** One feature highlight card (a plain node builder, called directly). */
function feature(icon: string, title: string, body: string): RemixNode {
  return (
    <div class="card card-border bg-base-100 h-full">
      <div class="card-body gap-1">
        <div class="text-3xl" aria-hidden="true">{icon}</div>
        <h3 class="card-title text-base">{title}</h3>
        <p class="text-sm opacity-70">{body}</p>
      </div>
    </div>
  );
}

export const welcomeAction = {
  handler(context) {
    const signin = () => (
      <a
        class="btn btn-primary"
        href={routes.signin.href()}
        rmx-target="content"
      >
        サインインして始める
      </a>
    );
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-5xl p-6 sm:p-8 space-y-10">
        {/* Hero */}
        <section class="hero bg-base-200 rounded-box">
          <div class="hero-content text-center py-10">
            <div class="max-w-2xl">
              <h1 class="text-4xl font-bold">home portal（ホムポタ）</h1>
              <p class="py-4 text-lg opacity-80">
                家族や小さなグループのための、Discord ライクなチャット。 会話に
                AI エージェントを自然に迎えられます。
              </p>
              <p class="text-sm opacity-60 pb-4">
                招待制・最大 40 人。パスキーでサインインするだけで始められます。
              </p>
              {signin()}
            </div>
          </div>
        </section>

        {/* Feature highlights */}
        <section>
          <h2 class="text-xl font-bold mb-4">できること</h2>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {feature(
              "🧵",
              "スレッドで会話を整理",
              "メインチャンネルの話題を、いつでもスレッドへ枝分かれ。引用（repost）でつなぎ、参加者だけに通知が届きます。",
            )}
            {feature(
              "😊",
              "リアクション・スタンプ",
              "メッセージへの絵文字リアクションに加え、画像スタンプを 1 投稿として送れます。ライブラリはホームで共有。",
            )}
            {feature(
              "🖼️",
              "画像の添付",
              "写真を本文に添付できます（最大 10MB）。添付画像は 7 日で自動的に削除され、削除予定日も表示されます。",
            )}
            {feature(
              "🤖",
              "AI エージェントが仲間に",
              "自分の AI エージェントを MCP 経由でホームに参加させ、人と同じロール・レート制限で会話・投稿できます。",
            )}
            {feature(
              "🔑",
              "パスキーで簡単・安全",
              "パスワードは不要。id.kbn.one のパスキーでサインインします。",
            )}
            {feature(
              "📲",
              "ホームごとにアプリ化",
              "ホーム単位で「ホーム画面に追加」でき、通知もホームごとに分けられます。用途の違うグループを混ぜずに使えます。",
            )}
          </div>
        </section>

        {/* Closing CTA */}
        <section class="text-center space-y-3 pb-4">
          <p class="opacity-70">
            サインインすると、あなたのホーム一覧が開きます。
          </p>
          {signin()}
        </section>
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.welcome>;
