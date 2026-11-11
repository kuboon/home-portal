# Cloudflare Workers へのデプロイと移行手順

home portal は Cloudflare Workers + D1 + Durable Objects で動く。アプリ本体は
Deno でビルドし、このディレクトリの `cf` CLI（npm）でデプロイする。

## 構成

| 役割                             | Cloudflare                                    | 以前（Deno Deploy）    |
| -------------------------------- | --------------------------------------------- | ---------------------- |
| サーバ                           | Worker `home-portal`                          | `deno serve router.ts` |
| ドメインデータ                   | D1 `home-portal`                              | Turso (libSQL)         |
| セッション・招待・レート制限ほか | D1 の `kv` テーブル（`@kuboon/kv/d1.ts`）     | Deno KV                |
| リアルタイム配信                 | Durable Object `ChannelHub`（チャンネル単位） | Deno KV watch          |
| 静的ファイル                     | Workers Static Assets                         | `staticFiles`          |
| 期限切れ KV 行の掃除             | Cron Trigger（毎時 17 分）                    | Deno KV の TTL         |

- KV に Workers KV ではなく D1 を使うのは、セッション・招待・レート制限が
  compare-and-set を必要とし、結果整合の Workers KV では満たせないため。
- ビルドの流れ（`deno task build:cloudflare` = `bundler/cloudflare.ts`）:
  1. client JS/CSS → `server/bundled/`
  2. `server/worker.ts` → `cloudflare/dist/worker.js`（`Deno.bundle`）
  3. `cf build` → `.cloudflare/output/v0/workers/default/`
  4. `server/bundled/` と `_headers` をその `assets/` へコピー
- 4 を自前でやっているのは、`cf` の設定（`cloudflare.config.ts`）が Vite を
  使わない Worker に assets
  ディレクトリを指定できないため。`cf deploy --prebuilt` は Build Output の
  `assets/` をそのままアップロードする。

## 移行手順（GitHub Actions だけで完結・ダウンタイムあり）

ローカル環境は要らない。ブラウザ（Cloudflare / Turso / Deno Deploy / GitHub
のダッシュボード）と、Actions の **cloudflare** workflow
（`.github/workflows/cloudflare.yml`、Run workflow で `step` を選ぶ）で進める。
ダウンタイムは手順 4〜6 の間（15 分程度）。

### 1. 認証情報を GitHub に登録する

Settings → Secrets and variables → Actions:

| 種類   | 名前                   | 値                                                                                                  |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| secret | `CLOUDFLARE_API_TOKEN` | 下記の権限を持つ API トークン                                                                       |
| secret | `TURSO_AUTH_TOKEN`     | Turso ダッシュボード → `home-portal-ohio` → Create Token（Read Only でよい・期限は 1 日程度でよい） |
| secret | `DENO_KV_URL`          | （任意）Deno Deploy の KV 画面の接続 URL（`https://api.deno.com/databases/<id>/connect`）           |
| secret | `DENO_KV_ACCESS_TOKEN` | （任意）Deno Deploy のアクセストークン                                                              |

- Cloudflare API トークン（My Profile → API Tokens → Create Token）:
  テンプレート **Edit Cloudflare Workers** を選び、次を追加する。
  - Account: **D1: Edit**
  - Zone `kbn.one`: **DNS: Edit**（カスタムドメインの DNS レコードと証明書を
    Worker が作るため。テンプレートの Workers Routes: Edit と合わせて使う）
  - Account Resources / Zone Resources は kuboon アカウントと `kbn.one` に絞る
  - Workers Scripts: Edit だけだと静的ファイルのアップロードなどで
    `403 No access to the specified resource` になる
- Turso の URL は既定で
  `libsql://home-portal-ohio-kuboon.aws-us-east-2.turso.io`。 違う場合は
  variable `TURSO_DATABASE_URL` で上書きする。
- `DENO_KV_*` を省くと、RP 署名鍵・リアクションの履歴・ログイン状態は移らない
  （鍵は初回アクセスで作り直され、全員が一度サインインし直す。それ以外の
  データには影響しない）。

### 2. Deno Deploy の GitHub 連携を外し、この PR をマージする

Deno Deploy は旧設定（`deno task pre-deploy` で Turso にマイグレーション、
エントリ `server/router.ts`）でビルドするので、連携したままマージすると本番の
ビルドが失敗する。連携を外しても、動いている本番はそのまま動き続ける。

マージしても Cloudflare には何も起きない（push での自動デプロイは
`CLOUDFLARE_AUTO_DEPLOY` を設定するまで無効）。

### 3. `step: setup` を実行する

- D1 `home-portal` を作る（primary は apac。既にあれば使う）
- スキーマ（`packages/db/migrations` の 0001〜0015）を適用する
- Worker をデプロイする（カスタムドメインは付けない）

ジョブのサマリに D1 の ID とデプロイ先の
`https://home-portal.<subdomain>.workers.dev` が出る。トップページと
`/.well-known/jwks.json` が返ることを確認する。本番の トラフィックはまだ Deno
Deploy に流れている。

### 4. Deno Deploy を止める（ダウンタイム開始）

以降に Turso / Deno KV へ書き込まれたデータは移らないので、先に止める。

### 5. `step: import-data` を実行する

- Turso の全テーブルを外部キー順に、Deno KV から RP 署名鍵・リアクションの
  履歴・ログイン状態（1 時間の TTL を付け直す）を書き出す。招待・レート制限・
  通知バックオフ・リアルタイムのシグナルは一時的な状態なので移さない。
- 空の D1 に取り込み、テーブルごとの件数を Turso と突き合わせる（ジョブの
  サマリに表が出る。1 つでも違えばジョブが失敗する）。
- D1 に既にユーザーがいれば取り込まずに失敗する（二重投入の防止）。
- ダンプはランナー上でだけ作り、ジョブの最後に消す（Artifact にはしない）。

### 6. ドメインを付け替えて `step: cutover` を実行する（ダウンタイム終了）

1. Deno Deploy のプロジェクトから `home.kbn.one` を外し、`home.kbn.one` の 既存
   DNS レコード（Deno Deploy 向け）を Cloudflare の DNS 画面で削除する。
2. variable `HOME_PORTAL_DOMAIN` = `home.kbn.one` を設定する。
3. `step: cutover` を実行する。マイグレーションを適用し、カスタムドメイン付きで
   デプロイする（Worker の Custom Domain が DNS レコードと証明書を作る）。

`RP_ORIGIN` は以前と同じ `https://home.kbn.one` なので、IdP の
`AUTHORIZE_WHITELIST` は変更不要。

### 7. 動作確認

- サインイン、Home 一覧、スレッド表示
- 2 つのタブで同じスレッドを開き、投稿・編集・削除・リアクションが即時反映される
- 画像 / スタンプの投稿（storage.kbn.one への直アップロード）
- テスト通知と、別ユーザーの投稿による push 通知
- MCP（`POST /mcp/<agentId>`）

### 8. 自動デプロイを有効にする

variable `CLOUDFLARE_AUTO_DEPLOY` = `true`。以後 main への push で、ビルド → D1
マイグレーション → デプロイ（`HOME_PORTAL_DOMAIN` 付き）が走る。
手動で出したいときは `step: deploy`。

### ロールバック

- 手順 6 より前なら、Deno Deploy を再開するだけでよい（Turso / Deno KV には
  手を付けていない）。
- 手順 6 の後に戻す場合、Cloudflare 側で増えた投稿は Turso に無い。D1 から
  書き戻す必要がある。

### 後片付け（しばらく様子を見てから）

- Turso の `home-portal-ohio`、Deno Deploy のプロジェクトと KV を削除する。
- secrets `TURSO_AUTH_TOKEN` / `DENO_KV_URL` / `DENO_KV_ACCESS_TOKEN` を削除し、
  Turso のトークンを失効させる。

## ローカルから操作する場合（任意）

workflow と同じことを手元でもできる（`cd cloudflare && npm ci`、
`CLOUDFLARE_API_TOKEN` と
`CLOUDFLARE_ACCOUNT_ID=ac92f36f0a2d84353b137574157f7480` を環境変数に設定）:

```bash
deno run -A scripts/cloudflare_api.ts ensure   # D1 を作成/検索して ID を表示
(cd cloudflare && npx cf d1 migrations apply <ID> --dir ../packages/db/migrations)
deno task deploy                               # HOME_PORTAL_DOMAIN でドメイン付与
TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… DENO_KV_ACCESS_TOKEN=… \
  deno run -A --unstable-kv scripts/export_data.ts [--kv <Deno KV URL>]
deno run -A scripts/import_d1.ts               # 取り込み + 件数検証
```

## 運用メモ

- ログ: Cloudflare ダッシュボードの Workers Logs（`observability` 有効）。 `cf`
  にはまだ tail が無いので、ストリームで見たいときは
  `npx wrangler tail
  home-portal`。
- リアルタイム配信は SSE を Durable Object 経由で張りっぱなしにするので、
  接続中は DO の実行時間（duration）が課金対象になる。利用が増えたら WebSocket
  Hibernation への置き換えを検討する。
- デプロイすると DO が再起動して SSE が切れるが、クライアントは再接続して
  取りこぼしを再取得する。
