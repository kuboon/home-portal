# home portal（ホムポタ）

家族・小グループ向けの Discord ライクなチャットプラットフォーム。AI
エージェントを MCP 経由でネイティブな参加者として統合することを目指す。**Deno +
Remix v3** で実装し、**Cloudflare Workers + D1 + Durable Objects** で動かす
（デプロイ・移行手順は `cloudflare/README.md`）。

参考実装: https://github.com/kuboon/deno-remix-reference

## 構成（Deno workspaces）

client / server を分離した Deno workspaces。

- `server/` — Remix v3 (fetch-router) サーバ。ランタイム非依存の
  `router.ts`（`createAppRouter`）を、本番は `worker.ts`（Workers エントリ:
  fetch / scheduled / Durable Object `ChannelHub`）、ローカルは `dev.ts`
  （`deno serve`。D1 → `node:sqlite`、DO → プロセス内ハブ）が包む。
  - `routes.ts` ルート定義 / `router.ts` 配線 / `controllers/` 各エンドポイント
  - `config.ts` 環境変数（`process.env` 経由。Workers は `nodejs_compat` で text
    vars が入る）
  - `ui/document.tsx` 永続シェル + `<Frame>` / `utils/render.tsx` レンダリング
  - `middleware/dpop.ts` DPoP セッション middleware の組み立て
- `client/` — ブラウザ実行コード。`hydration.ts`（フレーム遷移 + clientEntry の
  ハイドレーション）、`signin_card.tsx`（パスキーサインイン UI）。
- `bundler/` — `Deno.bundle` で client を `server/bundled/*.js`
  に、Tailwind/daisyUI を `server/bundled/style.css` にビルド。`worker.ts` は
  server を `cloudflare/dist/worker.js` に、`cloudflare.ts` は Workers の Build
  Output（`cf build` + assets コピー）を作る。
- `cloudflare/` — `cf` CLI（npm）と `cloudflare.config.ts`。Deno workspace
  外（`deno.json` の `exclude`）。
- `packages/db/` — Cloudflare D1 データ層。`client.ts`（D1 binding を libSQL
  風の `execute`/`batch` に包む。`setDatabase` で注入）/ `sqlite.ts`
  （テスト・ローカル用の `node:sqlite` 版 D1。Worker から import しない）/
  `migrate.ts`（テスト・ローカル用。本番は `cf d1 migrations apply`）/
  `migrations/` / `users.ts` / `homes.ts`（Home・メンバーシップ）/
  `threads.ts`（Thread・Message）。
- `scripts/` — Turso / Deno KV → D1 のデータ移行（`export_data.ts` /
  `import_d1.ts`）と D1 REST クライアント（`cloudflare_api.ts`）。GitHub Actions
  の `cloudflare` workflow（`setup` / `import-data` / `cutover` / `deploy`）から
  使う。
- `packages/session-storage-kv/` — `@remix-run/session` の `SessionStorage` を
  `KvRepo` で実装（reference から取り込み）。本番の repo は `@kuboon/kv/d1.ts`
  の `D1KvRepo`。
- `packages/remix-dpop-session-middleware/` — DPoP セッション
  middleware（reference から取り込み）。

## 認証・ストレージ方針

- 認証: パスキーは **id.kbn.one (IdP) に委譲**。home portal は DPoP セッション
  middleware で thumbprint にユーザーを紐づける。DPoP proof は
  [jsr:@kuboon/dpop](https://jsr.io/@kuboon/dpop) を利用。
- ドメインデータ（`users` ほか home/thread/message…）= **Cloudflare D1**。
- セッション・招待・レート制限・RP 署名鍵・絵文字履歴・通知バックオフ = 同じ D1
  の `kv` テーブル（`@kuboon/kv/d1.ts` の `D1KvRepo`、`server/kv.ts`）。
  compare-and-set が要るので Workers KV は使わない。D1 に TTL は無いので期限
  切れ行は毎時の cron（`scheduled`）で掃除する。
- リアルタイム配信は **SSE + Durable Objects**（`server/realtime.ts` /
  `realtime_do.ts`。チャンネルごとに `ChannelHub` が watch ストリームへ変更
  シグナルを配る）。メッセージは D1 が真実の源で、DO は変更シグナルのみ。

## 環境変数

- `IDP_ORIGIN` — IdP の origin（既定 `https://id.kbn.one`）
- `RP_ORIGIN` — home portal 自身の origin（既定 `https://home.kbn.one`）。push
  の client assertion の `iss`/`sub` 兼 JWKS 発行元。IdP の
  `AUTHORIZE_WHITELIST` に登録が必要。RP 署名鍵は D1 の `kv`
  テーブルに初回自動生成し `/.well-known/jwks.json` で公開。
- `STORAGE_ORIGIN` — スタンプ画像を置く storage.kbn.one の origin（既定
  `https://storage.kbn.one`）。ブラウザが id.kbn.one の DPoP トークンで直接
  アップロード/ダウンロードする（サーバは object key のみ保存）。
- `DEV_DB_PATH` — ローカル開発（`server/dev.ts`）の SQLite ファイル（既定
  `.local/dev.sqlite`）

Workers では上記 3 つの origin を `cloudflare/cloudflare.config.ts` の text vars
で渡す（D1 / DO は binding）。

## 開発

```bash
deno task dev               # bundler 実行 + server/dev.ts を --watch 起動
deno task test              # ユニットテスト（DB テストは node:sqlite :memory:）
deno task check             # deno check + lint + fmt --check
deno task build:cloudflare  # Workers 用 Build Output を生成
deno task deploy            # ビルド + cf deploy --prebuilt
```

## コーディング規約

- Deno ファースト（Web API 優先、Node.js API は必要最小限）
- TypeScript strict mode
- テストは `Deno.test()` + `@std/assert`、ファイル名はスネークケース（例:
  `users_test.ts`）

## スコープ（段階的実装）

**基盤**（雛形・データ層・認証・CI/デプロイ）+ **Home /
メンバー管理**（作成・一覧・ admin/member ロール・メンバー追加(userId
指定)/削除）+ **Thread / Message**（スレッド作成・一覧、メッセージ投稿・表示）+
**リアルタイム配信**（SSE + Durable Objects で新着・編集・削除を即時反映）+
**メッセージ編集・削除**（編集マーク / 論理削除の tombstone、author
編集・author/admin 削除）+
**Repost**（任意の投稿を引用してスレッドへピックアップ、 リンク平坦化）+
**レート制限**（投稿 1/秒・20/分、Repost 5/分、D1 の固定ウィンドウ）+
**招待トークン**（管理者画面表示中のみ有効・60秒無操作で失効、 コードで参加）+
**スレッドアーカイブ**（7日無投稿で自動・読み取り専用）+ **CSS テーマ**（home
admin のカスタム CSS、url()/@import 等のネットワーク取得は無効化）+
**リアクション**（メッセージへの絵文字、1投稿5個 まで、LRU 履歴）+ **Web Push
通知**（購読は id.kbn.one の push API に委譲＝`/sw.js` +
端末登録/テスト通知。新着は home portal サーバが `private_key_jwt` で
`POST /rp/notifications` を叩き、参加者へ
スレッド×ユーザーの指数バックオフ付きで配信）+
**エージェント・アカウント**（人間が 所有する `is_agent` ユーザーを作成し MCP 用
Bearer トークンを発行。Home には id 指定で メンバー追加）+ **MCP
サーバ**（`POST /mcp/:agentId`、 JSON-RPC。id.kbn.one の OAuth 2.1 / CIMD
アクセストークン（`aud` がそのエンドポイント。所有者のみ許可）か、エージェント
の `hpa_` トークンで認証し、list/post/thread/repost/react など Web UI
同等のツールを人間と同じロール・レート制限で実行。401 は RFC 9728 の
`WWW-Authenticate` を返し、`/.well-known/oauth-protected-resource/mcp/:agentId`
で認可サーバを案内）+ **スタンプ（ステッカー）**（画像は storage.kbn.one
にブラウザ直アップロード、 `kind='stamp'` の単独 post、ライブラリ 20 件
LRU・ホーム共有・使用時自動追加、 picker/設定 UI、MCP
`list_stamps`/`post_stamp`）+ **画像 post（添付）**（本文に画像 1
枚を添付。storage.kbn.one に直アップロード、 `messages.image_key` に object key
を保存、10MB・最大辺 4096px でクライアント 検証・縮小、composer 添付
UI・タイムライン描画・repost サムネイル。画像付き post は編集不可。**7
日で自動削除**＝`?expireDays=7` で storage の `expire-at` を記録し 日次 cron
が削除、UI に「M/D に削除されます」表示）まで実装済み。設計の全スコープを一巡。
