# home portal（ホムポタ）

家族・小グループ向けの Discord ライクなチャット。AI エージェントを MCP 経由で
ネイティブな参加者として迎えることを目指すプラットフォームです。

**Deno + Remix v3 + Deno Deploy** で実装します。設計の全体像とアーキテクチャは
[`CLAUDE.md`](./CLAUDE.md) を参照してください。

> 現状は **基盤** までの実装です（プロジェクト雛形・Deno workspaces・Turso
> データ層・
> パスキー認証・CI/デプロイ設定）。チャット機能本体は今後この土台の上に実装します。

## 必要なもの

- [Deno](https://deno.com/) v2.x
- [Turso CLI](https://docs.turso.tech/cli/installation)（ローカル開発用
  `turso dev`）

## セットアップ

```bash
# 1. 環境変数
cp .env.example .env
# .env を編集（ローカルは IDP_ORIGIN と TURSO_DATABASE_URL があれば動く）

# 2. ローカル libSQL サーバ（別ターミナル）
turso dev            # http://127.0.0.1:8080 で待ち受け

# 3. マイグレーション適用
deno task migrate

# 4. 開発サーバ起動（bundler 実行 + --watch）
deno task dev
```

ブラウザで `http://localhost:8000` を開き、`/signin`
でパスキーサインインを試せます。 サインインが確立すると、IdP の userId が Turso
の `users` に upsert されます。

## タスク

| タスク              | 内容                                                          |
| ------------------- | ------------------------------------------------------------- |
| `deno task dev`     | client をバンドルし、server を `--watch` で起動               |
| `deno task serve`   | バンドル + server を起動（本番相当）                          |
| `deno task bundle`  | client JS と Tailwind/daisyUI CSS を `server/bundled/` に出力 |
| `deno task migrate` | Turso にマイグレーションを適用                                |
| `deno task test`    | ユニットテスト（DB 必須テストは未設定時 skip）                |
| `deno task check`   | `deno check` + `deno lint` + `deno fmt --check`               |

## デプロイ（Deno Deploy）

- エントリポイント: `server/router.ts`（`deno serve` 互換）
- ビルドコマンド: `deno task bundle`（`server/bundled/` を生成）
- 環境変数: `IDP_ORIGIN`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
- 事前に本番 Turso DB に対して `deno task migrate` を実行

## ライセンス

[LICENSE](./LICENSE) を参照。
