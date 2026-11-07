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

## 事前準備

```bash
cd cloudflare && npm ci        # cf CLI（と、cf が委譲する wrangler）
npx cf auth login              # もしくは CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
```

複数アカウントにアクセスできる場合は `CLOUDFLARE_ACCOUNT_ID` で kuboon
のアカウントを指定する。

## 移行手順（ダウンタイムあり）

所要は 30 分程度。手順 4〜8 の間はサービス停止。

### 1. D1 を作る

利用者に近い場所に primary を置く（Worker は smart placement で D1
の近くで動く）。

```bash
cd cloudflare
npx cf d1 create --name home-portal --primary-location-hint apac
```

出力の database ID を控える（以下 `$D1`）。

### 2. スキーマを適用

```bash
npx cf d1 migrations apply $D1 --dir ../packages/db/migrations
```

`0001`〜`0015` が適用される（`0015_kv.sql` が Deno KV の代わりの `kv`
テーブル）。

### 3. 試しにデプロイ（ドメインはまだ付けない）

```bash
cd ..
deno task deploy
```

`https://home-portal.<subdomain>.workers.dev` でトップページと
`/.well-known/jwks.json` が返ることを確認する。この時点ではドメインを
付けないので、本番トラフィックは Deno Deploy のまま。

### 4. Deno Deploy を止める（ダウンタイム開始）

以降に Turso / Deno KV へ書き込まれたデータは移行されないので、先に止める。

### 5. データをエクスポート

```bash
TURSO_DATABASE_URL=libsql://home-portal-ohio-kuboon.aws-us-east-2.turso.io \
TURSO_AUTH_TOKEN="$(turso db tokens create home-portal-ohio --expiration 1d)" \
DENO_KV_ACCESS_TOKEN=<Deno Deploy のアクセストークン> \
deno run -A --unstable-kv scripts/export_data.ts --kv <Deno KV の接続 URL>
```

- `migration-data/data.sql`（gitignore 済み・利用者データを含むので扱い注意）に
  全テーブルの INSERT と、Deno KV のうち残す価値のある値が出力される。
  - RP 署名鍵 `rp_signing_key`: IdP は JWKS の `kid` で検証するので、同じ鍵を
    引き継ぐと push 通知が切れ目なく動く。
  - `recent-emoji`（リアクションの履歴）
  - `dpop-session`（ログイン状態。1 時間の TTL を付け直す）
  - 招待トークン・レート制限・通知バックオフ・リアルタイムのシグナルは一時的な
    状態なので移さない。
- Deno KV の接続 URL は Deno Deploy の KV 画面にある
  `https://api.deno.com/databases/<id>/connect` 形式のもの。取れない場合は
  `--kv` を省略してよい。その場合 RP 署名鍵は初回アクセス時に作り直され（IdP は
  新しい `kid` で JWKS を取り直す）、全員が一度サインインし直すことになる。

### 6. D1 にインポート

```bash
deno run -A scripts/import_d1.ts $D1
```

空の D1（手順 2 の直後）に対して 1 回だけ実行する。100 文ずつ、1 バッチ 1
トランザクションで `cf d1 query` に流す。

### 7. 件数を突き合わせる

```bash
cd cloudflare
npx cf d1 query $D1 --sql "SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM homes) homes, (SELECT count(*) FROM memberships) memberships, (SELECT count(*) FROM threads) threads, (SELECT count(*) FROM messages) messages, (SELECT count(*) FROM reactions) reactions, (SELECT count(*) FROM stamps) stamps, (SELECT count(*) FROM user_stamps) user_stamps, (SELECT count(*) FROM thread_participants) thread_participants, (SELECT count(*) FROM agents) agents"
```

同じ SQL を Turso（`turso db shell home-portal-ohio`）でも流し、一致を確認する。
エクスポート時に表示されたテーブル別件数とも比べられる。

### 8. ドメインを付け替える

1. Deno Deploy のプロジェクトから `home.kbn.one` を外し、`home.kbn.one` の 既存
   DNS レコード（Deno Deploy 向け）を削除する。
2. カスタムドメイン付きでデプロイする（`kbn.one` ゾーンが同じ Cloudflare
   アカウントにある前提。Worker の Custom Domain が DNS と証明書を作る）。

   ```bash
   HOME_PORTAL_DOMAIN=home.kbn.one deno task deploy
   ```

`RP_ORIGIN` は以前と同じ `https://home.kbn.one` なので、IdP の
`AUTHORIZE_WHITELIST` は変更不要。

### 9. 動作確認（ダウンタイム終了）

- サインイン、Home 一覧、スレッド表示
- 2 つのタブで同じスレッドを開き、投稿・編集・削除・リアクションが即時反映される
- 画像 / スタンプの投稿（storage.kbn.one への直アップロード）
- テスト通知と、別ユーザーの投稿による push 通知
- MCP（`POST /mcp/<agentId>`）

### 10. 自動デプロイを有効にする

GitHub の Settings → Secrets and variables → Actions に:

- secret `CLOUDFLARE_API_TOKEN`（Workers Scripts / D1 / Workers Routes
  編集権限）
- variable `CLOUDFLARE_ACCOUNT_ID`
- variable `D1_DATABASE_ID`（`$D1`）— これを設定するまで `deploy` workflow は
  何もしない
- variable `HOME_PORTAL_DOMAIN` = `home.kbn.one`

以後 main への push で、ビルド → D1 マイグレーション → デプロイが走る。 Deno
Deploy の GitHub 連携は外しておく。

### ロールバック

- 手順 8 より前なら、Deno Deploy を再開するだけでよい（Turso / Deno KV は
  手を付けていない）。
- 手順 8 の後に戻す場合、Cloudflare 側で増えた投稿は Turso に無い。D1 から
  `export_data.ts` と同じ形式で書き戻す必要がある。

### 後片付け（しばらく様子を見てから）

- Turso の `home-portal-ohio` と Deno Deploy のプロジェクト・KV を削除する。
- `migration-data/` を削除する。

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
