# 後続プラン (home portal / ホムポタ)

設計の全スコープを一巡し、基盤〜MCP サーバまで実装済み（`main`）。以下は v1 では
省略した、または現状とは異なる挙動の後続アイデア。

## 後続アイデア（未着手）

- MCP の**承認フロー**（非管理者エージェントの操作を管理者承認: pending キュー +
  UI）。
- メッセージ編集の設計挙動（編集はスレッド末尾へ移動 + 後方参照マーカー）—
  現状はその場更新 + 編集マーク。
- スレッドの**アンアーカイブ**、別スレッドを選んでの **Repost
  UI**（現状は現在スレッドへ）。
- エージェントのデモ実装（MCP クライアントから実際に投稿する例）。
- サーバ起点 push の本番 E2E 確認。

## スタンプ（ステッカー）— 未実装

### 背景・用語整理（実装済み）

従来「スタンプ」と呼んでいた機能は実体が**リアクション**（既存メッセージへ絵文字
を付ける）だったため、コード・API・UI・DB を「リアクション／emoji」に統一した
（`reactions.emoji`、`POST /api/messages/:id/reactions`、MCP `react` の `emoji`
引数、`GET /api/reactions/recent`、recent emoji の
LRU）。「スタンプ」の語は本来の ステッカー機能のために解放してある。

### この「スタンプ」とは

LINE / Discord ステッカー相当。**単一の投稿（post）**として送る絵柄で、ユーザは
あらかじめ自分の**スタンプライブラリ**を持ち、その中から選んで投稿する。リアク
ション（既存メッセージへの絵文字）とは別物。投稿はスレッド内の 1
メッセージとして
並び、Repost・削除・リアルタイム配信・レート制限・通知は既存メッセージ経路に乗せる。

### データモデル（案）— `0009_stamps.sql`

- `stamps`（素材マスタ）: `id`（ULID）/ `owner_id`（作成者, NULL=共有）/ `label`
  （代替テキスト）/ `image`（画像参照）/ `created_at`。
- `user_stamps`（ユーザのライブラリ・所持）: `(user_id, stamp_id)` 主キー +
  `order_idx` + `added_at`。
- メッセージ表現は **案A 推奨**: `messages` に `kind`（`'text' | 'stamp'`, 既定
  `'text'`）と `stamp_id` を追加。`kind='stamp'` のとき `body` は alt 用。
  `packages/db/threads.ts` の Message 型・`listMessages` で join 解決する。
  （案B: 本文を `stamp://<id>` 参照にして平坦化。Repost 平坦化と整合するが本文
  パースが増えるため非推奨。）

### 画像の取り扱い

CSS テーマで外部ネットワーク取得を無効化している方針に合わせ、スタンプ画像も
**外部 URL の直接埋め込みは避ける**。MVP は data URL（サイズ・MIME 制限つき）。
将来は内部 attachment ストレージを用意して `image` にその id を入れる。

### API / MCP

- `GET /api/stamps`（自分のライブラリ）/
  `POST /api/stamps`（作成＝ライブラリ追加）/
  `DELETE /api/stamps/:id`（ライブラリから外す）。
- `POST /api/threads/:threadId/stamps` `{ stampId }` — スタンプを 1
  投稿として送信。 実体は `postMessage` に `kind='stamp', stampId`
  を渡すラッパで、レート制限・
  アーカイブ判定・`signalThread`・通知は通常投稿と共通。
- MCP: `list_stamps` / `post_stamp`（`threadId`, `stampId`）を追加。人間と同じ
  ロール・レート制限で実行。
- レート制限はスタンプ投稿も通常メッセージ枠（1/秒・20/分）に含める。

### 段階実装

1. マイグレーション + `packages/db/stamps.ts`（ライブラリ CRUD）+ テスト。
2. `messages.kind`/`stamp_id` 追加、`threads.ts` の型拡張・join 解決 + テスト。
3. 投稿 API（ライブラリ／送信）を既存レート制限・通知経路へ接続。
4. UI（`client/homes_panel.tsx`）: 入力欄横の
   picker・タイムライン描画・ライブラリ 管理（MVP は追加／削除）。
5. MCP ツール（`list_stamps` / `post_stamp`）。
6. ドキュメント更新（`CLAUDE.md` のスコープに「スタンプ」を追記）。
