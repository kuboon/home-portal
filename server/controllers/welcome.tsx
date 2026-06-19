/**
 * GET /welcome — landing fragment shown in the shell's content frame.
 *
 * On a direct browser load, the shell is rendered and this same route is
 * re-entered through the frame resolver to provide the fragment.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { routes } from "../routes.ts";
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
              <a
                class="btn btn-primary"
                href={routes.signin.href()}
                rmx-target="content"
              >
                サインインして始める
              </a>
            </div>
          </div>
        </div>
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.welcome>;
