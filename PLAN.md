# 進捗・残タスク (home portal / ホムポタ)

`DESIGN.md` が正本。ここは実装状況と残タスクの索引。

## 実装済み（`main`・design v2 一巡）

- **基盤**: pre-deploy migration、Turso、DPoP セッション、CI / Deno Deploy。
- **メインチャンネル**: `thread_id = null` の post（専用テーブルなし）。
- **チャット UI**: ホーム毎
  URL（`/home/:id`・`/home/:id/thread/:tid`）、左サイドバー
  （メイン＋スレッド一覧）、URL 駆動、モバイルドロワー（右スワイプ）。`/homes`
  はハブ（一覧・作成・参加・メンバー/テーマ/招待）。
- **スレッド**: `thread_participants`（joined/left）、参加トリガ（post /
  そのスレッド 内 post への reaction で join、left→復帰）、明示
  leave、サイドバーの 参加/未参加/ アーカイブ グループ、`last_post_at`
  ベースの自動アーカイブ（archive 時に全員 left）、
  **タイトル編集**（作成者/admin）、**pickup**（複数
  source→スレッド、原本投稿者を 初期参加者に、pickup 枠 5/min・生成 repost は
  post 枠外）。
- **post モデル**: `kind`（normal/repost/edit）、`ref_post_id`、**モデレーション
  分離**（admin `hidden`=本文保持・admin のみ閲覧 / 著者
  `tombstone`=本文破棄）と ロール別可視性、**前方 repost
  方式の著者編集**（末尾再 post＋旧位置に edit マーカー、
  既存参照を最新版へ再ポイント、最新 post のみ編集可）、**双方向リンク** （「N
  件のスレッドで引用」）、リアクション（絵文字・1 投稿 5 個・recent LRU）。
- **通知**: スレッドは joined participant 限定 /
  メインは全メンバー、指数バックオフ
  （チャンネル×受信者）、チャンネルへディープリンク。
- **MCP**: list/post/repost/pickup/react/create_thread/rename_thread を web
  パリティで提供。
- **ホーム毎の表示名**: `memberships.display_name`（null は users.display_name
  に フォールバック）。参加（招待受諾）・ホーム作成時に入力、後から変更可。 ※
  IdP は `sub`(=userId) のみで名前クレームを持たないため、既定値は users の
  グローバル名（現状 userId 相当）。

## 残タスク（`DESIGN.md` の未実装 + 要決定）

### 機能（未実装）

- **画像スタンプ**（ライブラリ 20 件 / LRU / ホーム共有、MCP 連携）。
- **画像 post（添付）**。
- **ゲスト**（`GuestAccess`・スレッド単位招待、repost ジャンプ漏洩対策）。
- **request → approve**（非管理者の管理操作を admin 承認、`ApprovalRequest`）。
- **モデレーション**: suspend / ban、スレッド配下 post の一括非表示。
- **ホーム削除**（admin）。
- **オンボーディング**: PWA 追加・push 有効化の促し。
- 細部: スレッドのアンアーカイブは提供しない（仕様）/ 別スレッド選択の Repost UI
  / エージェントのデモ。

### 要決定（実装前に方針確定が必要）

- **画像の保存方式**: data URL（小・スタンプ向き）か内部 attachment
  ストレージか。 画像スタンプ・画像添付の双方が依存。
- **画像 post の保存ポリシー**: 何を・いつまで・どの解像度で保持するか。
- **ホーム削除**: 物理削除 / 論理削除（痕跡方針なら論理）。
- **web push の強制度**: 完全任意 / 繰り返し促す / 段階ゲート。
- 通知バックオフのリセット条件と cap（現状 cap 4 分・静穏でリセット）。
- 前方 edit マーカー UI の磨き込み、CSS `content`
  の許可ルール、リアクション頻度制限。

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
