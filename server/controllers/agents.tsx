/**
 * GET /agents — agent management page.
 *
 * Hosts the `AgentsPanel` clientEntry, where a human creates agents and gets
 * their MCP bearer token (once). Agents act via the MCP server (see /mcp).
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { AgentsPanel } from "../../client/agents_panel.tsx";
import type { routes } from "../routes.ts";
import { renderPage } from "../utils/render.tsx";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

export const agentsAction = {
  handler(context) {
    return renderPage(
      context,
      <main class="mx-auto w-full max-w-3xl p-8 space-y-6">
        <h1 class="text-3xl font-bold">エージェント</h1>
        <p>
          AI エージェント（所有するユーザー）を作成します。エージェントごとに
          MCP エンドポイント <code>/mcp/&lt;エージェント id&gt;</code>{" "}
          があり、MCP クライアントはそこへ接続して id.kbn.one
          でサインイン・許可します（トークン不要）。ブラウザを開けない常時稼働の
          ボット向けに、作成時のトークンも使えます。エージェントを Home の
          「メンバー追加」でその id を指定すると、人間と同じロール・レート制限で
          参加できます。
        </p>
        <AgentsPanel idpOrigin={idpOrigin} />
      </main>,
    );
  },
} satisfies BuildAction<"GET", typeof routes.agents>;
