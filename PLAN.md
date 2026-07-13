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
  既存参照を最新版へ再ポイント、自分の post
  は最新でなくても編集可）、**双方向リンク** （「N
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
- **画像スタンプ（ステッカー）**: 画像は **storage.kbn.one** に保存（下記）。
  ライブラリ 20 件 / LRU / ホーム共有 / 使用時自動追加、`kind='stamp'` の単独
  post、picker・設定画面のライブラリ管理、MCP `list_stamps` / `post_stamp`。

## 残タスク（`DESIGN.md` の未実装 + 要決定）

### 機能（未実装）

- **画像 post（添付）**。
- **ゲスト**（`GuestAccess`・スレッド単位招待、repost ジャンプ漏洩対策）。
- **request → approve**（非管理者の管理操作を admin 承認、`ApprovalRequest`）。
- **モデレーション**: suspend / ban、スレッド配下 post の一括非表示。
- **ホーム削除**（admin）。
- **オンボーディング**: PWA 追加・push 有効化の促し。
- 細部: スレッドのアンアーカイブは提供しない（仕様）/ 別スレッド選択の Repost UI
  / エージェントのデモ。

### 要決定（実装前に方針確定が必要）

- **画像の保存方式**: スタンプは **storage.kbn.one** で確定（下記）。画像
  post（添付）も同方式を想定するが、表示経路（blob URL で十分か）は要検討。
- **画像 post の保存ポリシー**: 何を・いつまで・どの解像度で保持するか。
- **ホーム削除**: 物理削除 / 論理削除（痕跡方針なら論理）。
- **web push の強制度**: 完全任意 / 繰り返し促す / 段階ゲート。
- 通知バックオフのリセット条件と cap（現状 cap 4 分・静穏でリセット）。
- 前方 edit マーカー UI の磨き込み、CSS `content`
  の許可ルール、リアクション頻度制限。

## スタンプ（ステッカー）— 実装済み

LINE / Discord ステッカー相当。**単一の投稿（post）**として送る絵柄で、ユーザは
自分の**スタンプライブラリ**（20 件・LRU）から選んで投稿する。リアクション
（既存メッセージへの絵文字）とは別物。投稿・Repost・削除・リアルタイム配信・
レート制限（通常メッセージ枠 1/秒・20/分）・通知は既存メッセージ経路に乗る。

### データモデル — `0012_stamps.sql`

- `stamps`（素材マスタ）: `id`（ULID）/ `owner_id` / `label`（alt 兼 通知本文）/
  `storage_key`（storage.kbn.one のオブジェクトキー）/ `content_type` /
  `created_at`。ライブラリから外れても行は残る（post が参照するため）。
- `user_stamps`（ライブラリ）: `(user_id, stamp_id)` 主キー + `added_at` +
  `last_used_at`（ミリ秒精度）。上限 20 件・LRU 押し出しは
  `packages/db/stamps.ts` の `touchStamp` が行う。
- `messages` に `stamp_id` を追加し `kind='stamp'` で投稿（`body` はラベル = alt
  用）。`threads.ts` の `MESSAGE_SELECT` が join 解決し、`Message.stamp` と
  repost プレビューの `repost.stamp` に載る。スタンプ post は編集不可
  （`kind='normal'` のみ編集可の既存制約）・削除は通常どおり。

### 画像の取り扱い — storage.kbn.one

画像バイトは home portal を経由しない。ブラウザが id.kbn.one の DPoP バインド
トークン（`/session` の `jws`）で **storage.kbn.one へ直接**
`POST /upload`（2MB・image/* をクライアント側で検証）し、返った `key` だけを
`POST /api/stamps` で登録する。表示も同様にブラウザが `GET /download?key=…` を
DPoP 付き fetch で取得し **blob URL** で `<img>` に出す（key 毎にページ内
メモ化、`client/storage.ts`）。CSP は `connect-src` に `STORAGE_ORIGIN`、
`img-src` に `blob:` を追加済み。テーマ CSS の「外部ネットワーク取得無効化」
方針はそのまま（スタンプは CSS ではなく認証付き fetch）。

### 共有モデル

- 同じホームの**現メンバー**が所有するスタンプは全員が閲覧・使用できる
  （`GET /api/homes/:homeId/stamps`、picker の「ホームのスタンプ」欄）。
- 他人のスタンプを使うと自分のライブラリへ**自動追加**（LRU 押し出し、
  `canUseStamp` → `touchStamp`）。設定画面にライブラリ管理（削除・満杯時の `!`
  バッジ = 次に押し出される 1 件）。

### API / MCP

- `GET /api/stamps` / `POST /api/stamps`（`{storageKey, label, contentType}`）/
  `DELETE /api/stamps/:stampId` / `GET /api/homes/:homeId/stamps`。
- 送信は既存の投稿 API に `{ stampId }`
  を渡す（`POST
  /api/threads/:threadId/messages`・`POST /api/homes/:homeId/messages`）。
- MCP: `list_stamps`（`homeId` 省略で自分のライブラリ）/
  `post_stamp`（`threadId`, `stampId`）。人間と同じロール・レート制限。
- 環境変数 `STORAGE_ORIGIN`（既定 `https://storage.kbn.one`）。

### 残改善（スタンプ）

- LRU 押し出しの**アニメーション可視化**（DESIGN の演出）は未実装。
- エージェント（MCP）からの**画像アップロード**は未対応（既存スタンプの
  list/post のみ。storage.kbn.one が id.kbn.one ユーザ認証のため）。
- blob URL はページ単位キャッシュのみ（Cache API 等の永続化は未対応）。
