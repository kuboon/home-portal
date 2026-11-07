# home portal（ホムポタ）

家族・小グループ向けの Discord ライクなチャット。AI エージェントを MCP 経由で
ネイティブな参加者として迎えることを目指すプラットフォームです。

**Deno + Remix v3** で実装し、**Cloudflare Workers + D1**
で動かします。設計の全体像とアーキテクチャは [`CLAUDE.md`](./CLAUDE.md)
を参照してください。

## 実装済みの機能

- パスキー認証（id.kbn.one へ委譲 + DPoP セッション）
- Home / メンバー管理（admin・member ロール）
- Thread / Message（投稿・編集・論理削除・Repost）
- リアルタイム配信（SSE + Durable Objects）
- レート制限・招待トークン・スレッド自動アーカイブ
- home ごとのカスタム CSS テーマ・リアクション（メッセージへの絵文字）
- Web Push 通知（購読は id.kbn.one へ委譲、配信はサーバ起点）
- エージェント・アカウント + MCP サーバ（`POST /mcp/<エージェント id>`、Web UI
  同等のツールを提供。認証は id.kbn.one の OAuth 2.1 / CIMD、または常時稼働の
  ボット向けのエージェントトークン）

## 必要なもの

- [Deno](https://deno.com/) v2.x
- デプロイする場合のみ: Node.js 22.23+ / 24（`cloudflare/` の `cf` CLI 用）

## ローカル開発

```bash
deno task dev
```

`server/dev.ts` が Workers の代わりを務める: D1 → `node:sqlite` のファイル
（`.local/dev.sqlite`、起動時にマイグレーション適用）、Durable Object →
プロセス内のハブ、Static Assets → `staticFiles`。外部サービスは不要。

ブラウザで `http://localhost:8000` を開き、`/signin`
でパスキーサインインを試せます。 サインインが確立すると、IdP の userId が D1 の
`users` に upsert されます。

## タスク

| タスク                       | 内容                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| `deno task dev`              | client をバンドルし、ローカルサーバ（`server/dev.ts`）を `--watch` 起動 |
| `deno task serve`            | バンドル + ローカルサーバ起動                                           |
| `deno task bundle`           | client JS と Tailwind/daisyUI CSS を `server/bundled/` に出力           |
| `deno task build:cloudflare` | Workers 用の Build Output を `cloudflare/.cloudflare/output/` に生成    |
| `deno task deploy`           | 上記ビルド + `cf deploy --prebuilt`                                     |
| `deno task test`             | ユニットテスト（DB テストは `node:sqlite` の `:memory:` で実行）        |
| `deno task check`            | `deno check` + `deno lint` + `deno fmt --check`                         |

## デプロイ（Cloudflare Workers）

[`cloudflare/README.md`](./cloudflare/README.md)
を参照（構成、初回セットアップ、 Deno Deploy / Turso
からのデータ移行手順、GitHub Actions による自動デプロイ）。

- Worker のエントリポイント: `server/worker.ts`（`Deno.bundle` で
  `cloudflare/dist/worker.js` にバンドル）
- 設定: `cloudflare/cloudflare.config.ts`（D1 `DB`、Durable Object
  `CHANNEL_HUB`、`IDP_ORIGIN` / `RP_ORIGIN` / `STORAGE_ORIGIN`、毎時の cron）
- D1 マイグレーション:
  `cf d1 migrations apply <id> --dir ../packages/db/migrations`
- サーバ起点 Web Push を使うには、`RP_ORIGIN` を IdP（id.kbn.one）の
  `AUTHORIZE_WHITELIST` に登録する（RP の client assertion 検証のため）

## ライセンス

[LICENSE](./LICENSE) を参照。
