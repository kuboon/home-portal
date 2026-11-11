-- 0015_calendar — ホームごとの共有カレンダー（予定）。
--
-- 日付と時刻はタイムゾーンを持たない「壁掛け時計」の文字列で持つ。家族の予定は
-- 「11/8 の 10 時」であって絶対時刻ではないので、UTC インスタントにはしない。
-- こうするとグリッドのセルがこの文字列そのもので決まり、タイムゾーン換算が
-- どこにも要らなくなる。`created_at` 等の記録時刻だけが従来どおり
-- `datetime('now')` 形式。
--
-- `start_time IS NULL` が終日イベント。CHECK で「終日 or 開始・終了の両方に
-- 時刻あり」を留めている（アプリ側の normalizeEvent のバックストップ）。
-- `end_date IS NULL` は start_date と同日の意味。
--
-- 繰り返し（RRULE）と参加可否（出欠）はあえて入れていない。繰り返しは展開と
-- 例外日の扱いで実装が跳ね上がるし、今の用途では「毎週の予定」を手で並べる方が
-- 誤解が少ない。どちらも必要になったら別テーブルで足せる形にしてある。
--
-- 削除は物理 DELETE。消えた予定を後から見せる要件がないため tombstone 列は
-- 置かない（メッセージの論理削除とは方針が違う）。
--
-- FK は 0004 / 0012 と同じ方針で、ALTER を単純に保つため messages 側への
-- 相互参照は張らない。

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,           -- ULID
  home_id    TEXT NOT NULL REFERENCES homes (id),
  title      TEXT NOT NULL,
  start_date TEXT NOT NULL,              -- 'YYYY-MM-DD'（TZ を持たない壁掛け日付）
  start_time TEXT,                       -- 'HH:MM'、NULL なら終日
  end_date   TEXT,                       -- NULL なら start_date と同日
  end_time   TEXT,                       -- 'HH:MM'、終日なら NULL
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at  TEXT,
  CHECK ((start_time IS NULL) = (end_time IS NULL))
);

CREATE INDEX IF NOT EXISTS events_home_date_idx ON events (home_id, start_date);
