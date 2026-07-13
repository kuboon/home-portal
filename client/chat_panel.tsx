/**
 * ChatPanel — the URL-driven chat view for one home (`/home/:homeId` and
 * `/home/:homeId/thread/:threadId`).
 *
 * Layout: a left sidebar listing the main channel + every thread, and a right
 * conversation pane. On desktop the sidebar is always shown (daisyUI
 * `lg:drawer-open`); on mobile it is an overlay drawer opened by the hamburger
 * button or a right-swipe from the screen edge.
 *
 * The "main channel" is the home's thread-less conversation; selecting it or a
 * thread swaps the conversation client-side and updates the URL (pushState)
 * without a full navigation.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { createA2hs, showA2hsGuide } from "@kuboon/browser-how-to/a2hs/ui";
import { qrPath } from "./qr.ts";
import { ensureSession, type FetchDpop } from "./session.ts";
import {
  stampImageUrl,
  type StorageSession,
  uploadStampImage,
} from "./storage.ts";

/** ホームごとに A2HS 案内を出したかを覚えるキー（何度も出さないため）。 */
const a2hsSeenKey = (homeId: string) => `bht_a2hs_seen_${homeId}`;

/**
 * ホームを開いたとき、まだホーム画面に追加しておらず、追加が可能な環境
 * （Android の native prompt / iOS Safari 等の手動手順）なら A2HS 案内を
 * 一度だけポップアップする。各ホームは個別に A2HS する思想なので、案内済み
 * フラグは homeId 単位で localStorage に保存する。インアプリブラウザや
 * PC など「追加できない環境」では出さない。
 */
function maybePromptA2hs(homeId: string): void {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(a2hsSeenKey(homeId))) return;
  } catch { /* localStorage 不可なら案内自体はしてよい */ }

  const controller = createA2hs();
  const markSeen = () => {
    try {
      localStorage.setItem(a2hsSeenKey(homeId), "1");
    } catch { /* ignore */ }
  };
  const show = () => {
    showA2hsGuide({ controller, onClose: markSeen, onInstalled: markSeen });
  };

  // `final` の間だけ Android を手動手順にフォールバックさせる。それまでは
  // beforeinstallprompt（native prompt）の発火を待つ。
  const decide = (final: boolean): boolean => {
    const s = controller.getStatus();
    if (s.support === "installed") return true; // 追加済み → 何もしない
    if (s.support === "native-prompt") {
      show();
      return true;
    }
    if (s.support === "manual") {
      if (s.device.platform === "android" && !final) return false;
      show();
      return true;
    }
    // in-app-blocked / unsupported は「可能なブラウザ」ではないので出さない。
    return false;
  };

  if (decide(false)) return;
  // Android の beforeinstallprompt は読み込み後に遅れて発火することがある。
  const off = controller.onChange(() => {
    if (decide(false)) off();
  });
  setTimeout(() => {
    off();
    decide(true);
  }, 2500);
}

export interface ChatPanelProps {
  idpOrigin: string;
  /** storage.kbn.one — hosts stamp images (browser-direct upload/download). */
  storageOrigin: string;
  homeId: string;
  /** Initial thread id from the URL, or "" for the main channel. */
  threadId: string;
  [key: string]: SerializableValue;
}

interface HomeWithRole {
  id: string;
  name: string;
  role: "admin" | "member";
  themeCss: string;
}

interface Thread {
  id: string;
  title: string;
  createdBy: string;
  archivedAt: string | null;
  joined: boolean;
}

interface Member {
  userId: string;
  displayName: string;
  isAgent: boolean;
  role: "admin" | "member";
}

/** A stamp (sticker) as the API returns it. */
interface Stamp {
  id: string;
  ownerId: string;
  label: string;
  storageKey: string;
  contentType: string;
  /** Only on /api/homes/:homeId/stamps: already in my library? */
  inLibrary?: boolean;
}

/** A message's resolved stamp reference. */
interface StampRef {
  id: string;
  label: string;
  storageKey: string;
}

interface Message {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  kind: "normal" | "repost" | "edit" | "stamp";
  deleted: boolean;
  hidden: boolean;
  repost: {
    authorName: string;
    body: string;
    deleted: boolean;
    stamp: StampRef | null;
  } | null;
  stamp: StampRef | null;
  quotedIn: { threadId: string; title: string }[];
  reactions: { emoji: string; count: number; mine: boolean }[];
}

const DEFAULT_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"];
/** ライブラリ上限（サーバ側 MAX_LIBRARY_STAMPS と揃える）。 */
const MAX_LIBRARY_STAMPS = 20;
const DRAWER_ID = "chat-drawer";
const COMPOSER_INPUT_ID = "chat-composer-input";

/** 同一著者の連投をひとまとめに表示する時間幅（Slack/Discord 風）。 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const AVATAR_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-600",
  "bg-green-600",
  "bg-teal-600",
  "bg-sky-600",
  "bg-blue-600",
  "bg-indigo-500",
  "bg-purple-500",
  "bg-pink-500",
] as const;

/** authorId から決定的にアバター色を選ぶ。 */
function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** SQLite の datetime('now')（UTC・"YYYY-MM-DD HH:MM:SS"）をパース。 */
function parseUtc(s: string): Date {
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

function fmtTime(s: string): string {
  const d = parseUtc(s);
  return isNaN(d.getTime())
    ? s
    : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(s: string): string {
  const d = parseUtc(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

/** 日付区切り判定用のキー（ローカルタイムゾーンの日単位）。 */
function dayKey(s: string): string {
  const d = parseUtc(s);
  return isNaN(d.getTime()) ? s : d.toDateString();
}

export const ChatPanel = clientEntry(
  "/chat_panel.js#ChatPanel",
  function ChatPanel(handle: Handle<ChatPanelProps>) {
    const homeId = handle.props.homeId;
    let ready = false;
    let userId: string | null = null;
    let thumbprint = "";
    let error = "";
    let homeName = "";
    let role: "admin" | "member" | null = null;
    let threads: Thread[] = [];
    let currentThreadId: string | null = handle.props.threadId || null;
    let messages: Message[] = [];
    let newMessage = "";
    /** 送信 API の完了待ちの間だけ画面に出す楽観的メッセージ。 */
    let pendingPosts: {
      id: string;
      body: string;
      createdAt: string;
      threadId: string | null;
    }[] = [];
    let pendingSeq = 0;
    let recentEmojis: string[] = [];
    // スタンプ: 自分のライブラリ / ホーム共有分 / picker の開閉 / blob URL。
    let accessToken: string | null = null;
    let myStamps: Stamp[] = [];
    let homeStamps: Stamp[] = [];
    let stampPickerOpen = false;
    let stampUploading = false;
    const stampUrls = new Map<string, string>();
    const stampUrlPending = new Set<string>();
    let paletteFor: string | null = null;
    let quotesFor: string | null = null;
    // 長押しで開くコンテキストメニュー（ボトムシート）。
    let menuFor: string | null = null;
    let menuOpenedAt = 0;
    // 長押し検出（touch）用のローカル状態。
    let lpTimer: ReturnType<typeof setTimeout> | null = null;
    let lpStartX = 0;
    let lpStartY = 0;
    let lpFired = false;
    let fetchDpop: FetchDpop | null = null;
    let streamAbort: AbortController | null = null;
    // 編集モード: 編集中メッセージ id と、[i] の説明ポップオーバー開閉。
    let editingId: string | null = null;
    let editInfoOpen = false;
    // Settings overlay + per-home management.
    let themeCss = "";
    let settingsOpen = false;
    let homeSettingsOpen = false;
    let nameDraft = "";
    let members: Member[] = [];
    let addUserId = "";
    let themeDraft = "";
    let inviteToken: string | null = null;
    let inviteTimer: ReturnType<typeof setInterval> | null = null;
    let inviteCopied = false;

    /** The shareable invite URL for the current token. */
    const inviteUrl = () =>
      inviteToken && typeof location !== "undefined"
        ? `${location.origin}/join/${inviteToken}`
        : "";

    const currentThread = () => threads.find((t) => t.id === currentThreadId);
    const archived = () => !!currentThread()?.archivedAt;
    const channelName = () =>
      currentThreadId ? (currentThread()?.title ?? "スレッド") : "メイン";
    /** API base for the active channel (main channel or a thread). */
    const channelBase = () =>
      currentThreadId
        ? `/api/threads/${currentThreadId}`
        : `/api/homes/${homeId}`;

    const applyTheme = (css: string) => {
      if (typeof document === "undefined") return;
      const id = "home-theme";
      let el = document.getElementById(id) as HTMLStyleElement | null;
      if (!css) {
        el?.remove();
        return;
      }
      if (!el) {
        el = document.createElement("style");
        el.id = id;
        document.head.appendChild(el);
      }
      el.textContent = css;
    };

    const closeDrawer = () => {
      if (typeof document === "undefined") return;
      const cb = document.getElementById(DRAWER_ID) as HTMLInputElement | null;
      if (cb) cb.checked = false;
    };

    const openMenu = (id: string) => {
      menuFor = id;
      menuOpenedAt = Date.now();
      paletteFor = null;
      quotesFor = null;
      // 長押しとほぼ同時に iOS Safari が始めてしまうテキスト選択を打ち消す
      // （CSS の user-select:none と合わせた保険）。
      try {
        globalThis.getSelection?.()?.removeAllRanges();
      } catch { /* no-op */ }
      handle.update();
    };
    const closeMenu = () => {
      if (menuFor === null) return;
      menuFor = null;
      handle.update();
    };
    const clearLongPress = () => {
      if (lpTimer !== null) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    };

    const api = async (path: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetchDpop!(path, init);
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          (data as { error?: string }).error ?? response.statusText,
        );
      }
      return data;
    };

    const run = async (fn: () => Promise<void>) => {
      error = "";
      try {
        await fn();
      } catch (e) {
        error = (e as Error).message;
      } finally {
        handle.update();
      }
    };

    const loadHome = async () => {
      const data = await api("/api/homes") as { homes: HomeWithRole[] };
      const home = data.homes.find((h) => h.id === homeId);
      if (!home) throw new Error("このホームにアクセスできません");
      homeName = home.name;
      role = home.role;
      themeCss = home.themeCss;
      applyTheme(themeCss);
    };

    const loadThreads = async () => {
      const data = await api(`/api/homes/${homeId}/threads`) as {
        threads: Thread[];
      };
      threads = data.threads;
    };

    const loadMessages = async () => {
      const data = await api(`${channelBase()}/messages`) as {
        messages: Message[];
      };
      messages = data.messages;
    };

    const loadRecentEmojis = async () => {
      const data = await api("/api/reactions/recent") as { emojis: string[] };
      recentEmojis = data.emojis;
    };

    const loadStamps = async () => {
      const [mine, home] = await Promise.all([
        api("/api/stamps") as Promise<{ stamps: Stamp[] }>,
        api(`/api/homes/${homeId}/stamps`) as Promise<{ stamps: Stamp[] }>,
      ]);
      myStamps = mine.stamps;
      homeStamps = home.stamps;
    };

    const storageSession = (): StorageSession | null =>
      fetchDpop && accessToken
        ? {
          fetchDpop,
          accessToken,
          storageOrigin: handle.props.storageOrigin,
        }
        : null;

    /**
     * storage.kbn.one の画像の blob URL。未取得ならダウンロードを開始して
     * いったん null を返し、完了時に re-render する（1 key につき 1 回）。
     */
    const stampSrc = (key: string): string | null => {
      const hit = stampUrls.get(key);
      if (hit) return hit;
      const session = storageSession();
      if (!session || stampUrlPending.has(key)) return null;
      stampUrlPending.add(key);
      stampImageUrl(session, key)
        .then((url) => {
          stampUrls.set(key, url);
          handle.update();
        })
        .catch(() => {})
        .finally(() => stampUrlPending.delete(key));
      return null;
    };

    /** スタンプ画像（取得中は skeleton）。`cls` でサイズを指定する。 */
    const stampImg = (key: string, label: string, cls: string) => {
      const src = stampSrc(key);
      return src
        ? <img src={src} alt={label} title={label} class={cls} />
        : <div class={`skeleton ${cls}`} title={label}></div>;
    };

    const toggleStampPicker = () => {
      stampPickerOpen = !stampPickerOpen;
      handle.update();
      if (stampPickerOpen) run(loadStamps);
    };

    /** スタンプを 1 投稿として送信（テキストと同じ投稿枠・経路）。 */
    const onPostStamp = (stampId: string) => {
      if (archived()) return;
      stampPickerOpen = false;
      error = "";
      handle.update();
      (async () => {
        try {
          await api(`${channelBase()}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stampId }),
          });
          await loadMessages();
          // 使用で LRU 順・自動追加が変わるのでライブラリも取り直す。
          await loadStamps();
        } catch (e) {
          error = (e as Error).message;
        } finally {
          handle.update();
        }
      })();
    };

    /** 画像を storage.kbn.one へ直接アップロードし、スタンプとして登録。 */
    const onUploadStamp = (file: File) =>
      run(async () => {
        const session = storageSession();
        if (!session) throw new Error("サインインし直してください");
        stampUploading = true;
        handle.update();
        try {
          const key = await uploadStampImage(session, file);
          await api("/api/stamps", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storageKey: key,
              label: file.name.replace(/\.[^.]+$/, ""),
              contentType: file.type,
            }),
          });
          await loadStamps();
        } finally {
          stampUploading = false;
        }
      });

    const onRemoveStamp = (stampId: string) =>
      run(async () => {
        await api(`/api/stamps/${stampId}`, { method: "DELETE" });
        await loadStamps();
      });

    /** Open the active channel's SSE stream; re-fetch messages on each ping. */
    const startStream = (threadId: string | null) => {
      streamAbort?.abort();
      const ac = new AbortController();
      streamAbort = ac;
      const src = threadId
        ? `/api/threads/${threadId}/stream`
        : `/api/homes/${homeId}/stream`;
      (async () => {
        const response = await fetchDpop!(src, { signal: ac.signal });
        if (!response.ok || !response.body) return;
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const event = block.split("\n").find((l) => l.startsWith("event:"))
              ?.slice(6).trim();
            if (event === "sync" && currentThreadId === threadId) {
              await loadMessages();
              handle.update();
            }
          }
        }
      })().catch(() => {});
    };

    const urlFor = (threadId: string | null) =>
      threadId ? `/home/${homeId}/thread/${threadId}` : `/home/${homeId}`;

    const selectChannel = (threadId: string | null) =>
      run(async () => {
        currentThreadId = threadId;
        paletteFor = null;
        stampPickerOpen = false;
        // 別チャンネルへ移ると編集対象が見えなくなるので編集モードを解除。
        editingId = null;
        editInfoOpen = false;
        newMessage = "";
        if (typeof history !== "undefined") {
          history.pushState({}, "", urlFor(threadId));
        }
        closeDrawer();
        await loadMessages();
        startStream(threadId);
      });

    const onLeave = (threadId: string) =>
      run(async () => {
        await api(`/api/threads/${threadId}/leave`, { method: "POST" });
        await loadThreads();
      });

    const onPickupToNewThread = (messageId: string) =>
      run(async () => {
        // Title is auto-derived from the first 10 chars of the replied-to post
        // (editable later), so the reply flow needs no prompt.
        const src = messages.find((x) => x.id === messageId);
        const base = (src?.body ?? src?.repost?.body ?? "")
          .replace(/\s+/g, " ").trim();
        const title = base.slice(0, 10) || "スレッド";
        const data = await api(`/api/homes/${homeId}/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            sourcePostIds: [messageId],
          }),
        }) as { thread: Thread };
        await loadThreads();
        await selectChannel(data.thread.id);
      });

    const onRenameThread = (threadId: string, current: string) =>
      run(async () => {
        const next = globalThis.prompt("スレッド名を編集", current);
        if (next == null || !next.trim()) return;
        await api(`/api/threads/${threadId}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: next.trim() }),
        });
        await loadThreads();
      });

    const loadMembers = async () => {
      const data = await api(`/api/homes/${homeId}/members`) as {
        members: Member[];
      };
      members = data.members;
    };

    const openSettings = () =>
      run(async () => {
        closeDrawer();
        await loadMembers();
        await loadStamps();
        nameDraft = members.find((m) => m.userId === userId)?.displayName ??
          userId ?? "";
        themeDraft = themeCss;
        settingsOpen = true;
      });

    const closeSettings = () => {
      settingsOpen = false;
      homeSettingsOpen = false;
      stopInviteHeartbeat();
      handle.update();
    };

    const onSaveName = () =>
      run(async () => {
        await api(`/api/homes/${homeId}/name`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: nameDraft }),
        });
        await loadMembers();
        await loadMessages(); // author name reflects the new name
      });

    const onAddMember = () =>
      run(async () => {
        const uid = addUserId.trim();
        if (!uid) return;
        await api(`/api/homes/${homeId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid }),
        });
        addUserId = "";
        await loadMembers();
      });

    const onSetRole = (uid: string, r: "admin" | "member") =>
      run(async () => {
        await api(`/api/homes/${homeId}/members/${uid}/role`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: r }),
        });
        await loadMembers();
        await loadHome(); // my own role may have changed
      });

    const onRemoveMember = (uid: string) =>
      run(async () => {
        await api(`/api/homes/${homeId}/members/${uid}`, { method: "DELETE" });
        await loadMembers();
      });

    const stopInviteHeartbeat = () => {
      if (inviteTimer !== null) {
        clearInterval(inviteTimer);
        inviteTimer = null;
      }
      inviteToken = null;
      inviteCopied = false;
    };

    const onInvite = () =>
      run(async () => {
        const data = await api(`/api/homes/${homeId}/invite`, {
          method: "POST",
        }) as { token: string };
        inviteToken = data.token;
        inviteCopied = false;
        if (inviteTimer !== null) clearInterval(inviteTimer);
        inviteTimer = setInterval(() => {
          if (inviteToken && fetchDpop) {
            fetchDpop(`/api/invites/${inviteToken}/heartbeat`, {
              method: "POST",
            }).catch(() => {});
          }
        }, 20_000);
      });

    const onCopyInvite = () =>
      run(async () => {
        const url = inviteUrl();
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          inviteCopied = true;
        } catch {
          // Clipboard blocked (insecure context / permissions): leave the URL
          // visible for manual copy.
          inviteCopied = false;
        }
      });

    const onCloseInvite = () =>
      run(async () => {
        const token = inviteToken;
        stopInviteHeartbeat();
        if (token) await api(`/api/invites/${token}`, { method: "DELETE" });
      });

    const onSaveTheme = () =>
      run(async () => {
        const data = await api(`/api/homes/${homeId}/theme`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ css: themeDraft }),
        }) as { themeCss: string };
        themeDraft = data.themeCss;
        themeCss = data.themeCss;
        applyTheme(themeCss);
      });

    /**
     * 楽観的送信: 入力欄を即クリアして「送信中」の行をその場で表示し、API
     * 完了後にサーバの内容へ置き換える。失敗時は行を取り下げ、（新たに入力
     * が始まっていなければ）本文を入力欄に戻す。
     */
    const onPost = () => {
      const body = newMessage.trim();
      if (!body || archived()) return;
      // 編集モード中は当該メッセージを編集（サーバ側で「編集マーク＋末尾に
      // 新規投稿」になる）。それ以外は通常の楽観的送信。
      if (editingId) {
        const id = editingId;
        editingId = null;
        editInfoOpen = false;
        newMessage = "";
        error = "";
        handle.update();
        (async () => {
          try {
            await api(`/api/messages/${id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body }),
            });
          } catch (e) {
            error = (e as Error).message;
          } finally {
            await loadMessages();
            handle.update();
          }
        })();
        return;
      }
      const base = channelBase();
      const pending = {
        id: `pending-${++pendingSeq}`,
        body,
        // サーバの datetime('now') と同じ UTC "YYYY-MM-DD HH:MM:SS" 形式。
        createdAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        threadId: currentThreadId,
      };
      newMessage = "";
      error = "";
      pendingPosts = [...pendingPosts, pending];
      handle.update();
      (async () => {
        try {
          await api(`${base}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          });
          await loadMessages();
        } catch (e) {
          error = (e as Error).message;
          if (!newMessage.trim()) newMessage = body;
        } finally {
          pendingPosts = pendingPosts.filter((p) => p.id !== pending.id);
          handle.update();
        }
      })();
    };

    /** Enter edit mode: load the post's body into the composer and focus it. */
    const onEdit = (messageId: string, current: string) => {
      editingId = messageId;
      editInfoOpen = false;
      newMessage = current;
      error = "";
      handle.update();
      if (typeof document !== "undefined") {
        setTimeout(() => {
          const el = document.getElementById(
            COMPOSER_INPUT_ID,
          ) as HTMLInputElement | null;
          el?.focus();
          el?.setSelectionRange(el.value.length, el.value.length);
        }, 0);
      }
    };

    const cancelEdit = () => {
      editingId = null;
      editInfoOpen = false;
      newMessage = "";
      handle.update();
    };

    const onDelete = (messageId: string) =>
      run(async () => {
        if (!globalThis.confirm("このメッセージを削除しますか？")) return;
        await api(`/api/messages/${messageId}`, { method: "DELETE" });
        await loadMessages();
      });

    /**
     * ローカルの messages にリアクションのトグルを即時反映する（楽観的更新）。
     * サーバの真実はあとで loadMessages() が上書きする。
     */
    const applyReactionLocally = (messageId: string, emoji: string) => {
      messages = messages.map((m) => {
        if (m.id !== messageId) return m;
        const rs = m.reactions.map((r) => ({ ...r }));
        const idx = rs.findIndex((r) => r.emoji === emoji);
        if (idx >= 0) {
          const r = rs[idx];
          if (r.mine) {
            r.count -= 1;
            r.mine = false;
            if (r.count <= 0) rs.splice(idx, 1);
          } else {
            r.count += 1;
            r.mine = true;
          }
        } else {
          rs.push({ emoji, count: 1, mine: true });
        }
        return { ...m, reactions: rs };
      });
    };

    // 送信メッセージと同じく楽観的に先行反映し、往復後に loadMessages() で
    // サーバの内容へ整合させる（失敗時もサーバ状態に戻るので巻き戻し不要）。
    const onToggleReaction = (messageId: string, emoji: string) => {
      paletteFor = null;
      applyReactionLocally(messageId, emoji);
      error = "";
      handle.update();
      (async () => {
        try {
          await api(`/api/messages/${messageId}/reactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emoji }),
          });
        } catch (e) {
          error = (e as Error).message;
        } finally {
          await loadMessages();
          await loadRecentEmojis();
          handle.update();
        }
      })();
    };

    if (typeof document !== "undefined") {
      // Right-swipe from the left edge opens the drawer; left-swipe closes it.
      // (No-op on desktop where the drawer is always open via CSS.)
      let sx = 0;
      let sy = 0;
      document.addEventListener("touchstart", (e) => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
      }, { passive: true });
      document.addEventListener("touchend", (e) => {
        const t = e.changedTouches[0];
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (Math.abs(dy) > 50) return;
        const cb = document.getElementById(DRAWER_ID) as
          | HTMLInputElement
          | null;
        if (!cb) return;
        if (sx < 40 && dx > 60) cb.checked = true;
        else if (cb.checked && dx < -60) cb.checked = false;
      }, { passive: true });

      // Keep the view in sync with browser back/forward.
      globalThis.addEventListener("popstate", () => {
        const m = location.pathname.match(/\/home\/[^/]+\/thread\/([^/]+)/);
        const threadId = m ? m[1] : null;
        if (threadId !== currentThreadId) {
          currentThreadId = threadId;
          loadMessages().then(() => {
            startStream(threadId);
            handle.update();
          }).catch(() => {});
        }
      });

      (async () => {
        try {
          const session = await ensureSession(handle.props.idpOrigin);
          fetchDpop = session.fetchDpop;
          userId = session.userId;
          thumbprint = session.thumbprint;
          accessToken = session.accessToken;
          if (userId) {
            await loadHome();
            await loadThreads();
            await loadMessages();
            await loadRecentEmojis();
            startStream(currentThreadId);
            // ホームを開けたら、必要なら A2HS 案内をポップアップ。
            maybePromptA2hs(homeId);
          }
        } catch (e) {
          error = (e as Error).message;
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    /** アバター（authorId から決定的な色 + 頭文字）。 */
    const avatar = (m: Message) => (
      <div
        class={`w-9 h-9 mt-0.5 rounded-lg flex items-center justify-center text-white font-bold select-none shrink-0 ${
          avatarColor(m.authorId)
        }`}
      >
        {(m.authorName || "?").slice(0, 1).toUpperCase()}
      </div>
    );

    /**
     * Slack/Discord 風のフラットなメッセージ行。`grouped` のとき（直前と同一
     * 著者の連投）はアバター・名前を省き、ホバー時のみ左端に時刻を出す。
     */
    const messageRow = (m: Message, grouped: boolean, pending = false) => {
      if (m.kind === "edit") {
        // Forward marker left where the post used to be; the edited version is
        // re-posted at the tail.
        return (
          <div key={m.id} class="px-4 py-0.5 pl-16 text-xs italic opacity-50">
            ✏️ {m.authorName} さんがこの投稿を編集しました（最新版は下）
          </div>
        );
      }
      const mine = m.authorId === userId;
      const canDelete = mine || role === "admin";
      // 長押しでコンテキストメニューを開く（実メッセージのみ）。10px 以上
      // 動いたらスクロール扱いでキャンセル。発火後の合成 click は touchend の
      // preventDefault と scrim 側の時間ガードの二重で握り潰す。ハンドラは
      // `mix` に直接書く（`on` の型は載せる要素から推論されるため、配列に
      // 切り出すと target が Element になり touch イベントが解決されない）。
      const actionable = !pending && !m.deleted;
      return (
        <div
          key={m.id}
          class={`chat-msg group relative flex gap-3 px-4 py-0.5 hover:bg-base-200/60 ${
            grouped ? "" : "mt-2"
          } ${pending ? "opacity-60" : ""} ${
            editingId === m.id ? "bg-warning/15 ring-1 ring-warning/40" : ""
          }`}
          mix={actionable
            ? [
              on("touchstart", (e) => {
                const t = e.touches[0];
                if (!t) return;
                lpStartX = t.clientX;
                lpStartY = t.clientY;
                lpFired = false;
                clearLongPress();
                lpTimer = setTimeout(() => {
                  lpTimer = null;
                  lpFired = true;
                  openMenu(m.id);
                }, 450);
              }),
              on("touchmove", (e) => {
                const t = e.touches[0];
                if (!t) return;
                if (
                  Math.abs(t.clientX - lpStartX) > 10 ||
                  Math.abs(t.clientY - lpStartY) > 10
                ) clearLongPress();
              }),
              on("touchend", (e) => {
                clearLongPress();
                if (lpFired) {
                  lpFired = false;
                  e.preventDefault();
                }
              }),
              on("touchcancel", () => clearLongPress()),
            ]
            : []}
        >
          {grouped
            ? (
              <div class="w-9 shrink-0 text-right select-none">
                {pending
                  ? (
                    <span class="loading loading-dots loading-xs opacity-50">
                    </span>
                  )
                  : (
                    <time class="invisible group-hover:visible text-[10px] leading-6 opacity-50">
                      {fmtTime(m.createdAt)}
                    </time>
                  )}
              </div>
            )
            : avatar(m)}
          <div class="flex-1 min-w-0">
            {grouped ? null : (
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="font-bold leading-tight">{m.authorName}</span>
                {pending
                  ? <span class="text-xs opacity-50">送信中…</span>
                  : (
                    <time class="text-xs opacity-50">
                      {fmtTime(m.createdAt)}
                    </time>
                  )}
                {m.hidden
                  ? (
                    <span class="badge badge-warning badge-xs">
                      管理者により非表示
                    </span>
                  )
                  : null}
              </div>
            )}
            {m.deleted
              ? (
                <div class="italic opacity-50 leading-relaxed">
                  このメッセージは削除されました
                </div>
              )
              : null}
            {!m.deleted && m.repost
              ? (
                <div class="border-l-2 border-base-content/25 pl-3 my-1 text-sm opacity-75">
                  <span class="font-semibold">{m.repost.authorName}</span>{" "}
                  {m.repost.deleted
                    ? <span class="italic">削除されました</span>
                    : m.repost.stamp
                    ? stampImg(
                      m.repost.stamp.storageKey,
                      m.repost.stamp.label,
                      "h-16 w-16 object-contain mt-1",
                    )
                    : m.repost.body}
                </div>
              )
              : null}
            {!m.deleted && m.kind === "stamp"
              ? (
                // スタンプ投稿: body はラベル（alt 用）なので画像だけを出す。
                <div class={`my-0.5 ${m.hidden ? "opacity-60" : ""}`}>
                  {m.stamp
                    ? stampImg(
                      m.stamp.storageKey,
                      m.stamp.label,
                      "chat-stamp h-32 w-32 object-contain object-left",
                    )
                    : <span class="italic opacity-50">{m.body}</span>}
                </div>
              )
              : null}
            {!m.deleted && m.kind !== "stamp"
              ? (
                <div
                  class={`whitespace-pre-wrap break-words leading-relaxed ${
                    m.hidden ? "opacity-60" : ""
                  }`}
                >
                  {m.body}
                  {m.editedAt
                    ? <span class="text-xs opacity-50 ml-1">(編集済み)</span>
                    : null}
                </div>
              )
              : null}
            {!m.deleted && m.reactions.length > 0
              ? (
                <div class="flex flex-wrap items-center gap-1 mt-1">
                  {m.reactions.map((r) => (
                    <button
                      type="button"
                      key={r.emoji}
                      class={`h-6 rounded-full border px-2 text-xs inline-flex items-center gap-1 ${
                        r.mine
                          ? "border-primary bg-primary/10"
                          : "border-base-300 bg-base-200 hover:border-base-content/40"
                      }`}
                      disabled={archived()}
                      mix={[on("click", () => onToggleReaction(m.id, r.emoji))]}
                    >
                      <span>{r.emoji}</span>
                      <span class="font-semibold tabular-nums">{r.count}</span>
                    </button>
                  ))}
                  {!archived()
                    ? (
                      <button
                        type="button"
                        class="h-6 rounded-full border border-dashed border-base-content/25 px-2 text-xs opacity-60 hover:opacity-100"
                        aria-label="リアクションを追加"
                        mix={[on("click", () => {
                          paletteFor = paletteFor === m.id ? null : m.id;
                          handle.update();
                        })]}
                      >
                        +
                      </button>
                    )
                    : null}
                </div>
              )
              : null}
            {!m.deleted && paletteFor === m.id
              ? (
                <div class="mt-1 w-fit flex flex-wrap gap-0.5 rounded-xl border border-base-300 bg-base-100 p-1.5 shadow-lg">
                  {[...new Set([...recentEmojis, ...DEFAULT_EMOJIS])].map(
                    (e) => (
                      <button
                        type="button"
                        key={e}
                        class="btn btn-ghost btn-sm px-1.5 text-lg"
                        mix={[on("click", () => onToggleReaction(m.id, e))]}
                      >
                        {e}
                      </button>
                    ),
                  )}
                </div>
              )
              : null}
            {m.quotedIn.length > 0
              ? (
                <div class="mt-1">
                  <button
                    type="button"
                    class="text-xs opacity-60 hover:opacity-100 hover:underline"
                    mix={[on("click", () => {
                      quotesFor = quotesFor === m.id ? null : m.id;
                      handle.update();
                    })]}
                  >
                    💬 {m.quotedIn.length} 件のスレッドで引用
                  </button>
                  {quotesFor === m.id
                    ? (
                      <ul class="menu menu-xs bg-base-200 rounded-box mt-1 w-fit">
                        {m.quotedIn.map((q) => (
                          <li key={q.threadId}>
                            <a
                              mix={[
                                on("click", () => selectChannel(q.threadId)),
                              ]}
                            >
                              <span class="truncate">{q.title}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )
                    : null}
                </div>
              )
              : null}
          </div>
          {/* Hover actions in the top-right of the row (Slack/Discord style). */}
          {m.deleted || pending
            ? null
            : (
              <div class="absolute -top-3 right-4 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex rounded-lg border border-base-300 bg-base-100 shadow-md overflow-hidden">
                {archived() ? null : (
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs rounded-none"
                    aria-label="リアクション"
                    title="リアクション"
                    mix={[on("click", () => {
                      paletteFor = paletteFor === m.id ? null : m.id;
                      handle.update();
                    })]}
                  >
                    😀
                  </button>
                )}
                <button
                  type="button"
                  class="btn btn-ghost btn-xs rounded-none"
                  aria-label="スレッドで返信"
                  title="スレッドで返信"
                  mix={[on("click", () => onPickupToNewThread(m.id))]}
                >
                  ↩︎
                </button>
                {!archived() && mine && m.kind === "normal"
                  ? (
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs rounded-none"
                      aria-label="編集"
                      title="編集"
                      mix={[on("click", () => onEdit(m.id, m.body))]}
                    >
                      ✏️
                    </button>
                  )
                  : null}
                {!archived() && canDelete
                  ? (
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs rounded-none"
                      aria-label="削除"
                      title="削除"
                      mix={[on("click", () => onDelete(m.id))]}
                    >
                      🗑
                    </button>
                  )
                  : null}
              </div>
            )}
        </div>
      );
    };

    /**
     * メッセージ列（日付区切り + 連投グルーピング）。逆順で返し、コンテナの
     * `flex-col-reverse` と合わせて常に最下部（最新）に張り付くようにする。
     */
    /** 自分の表示名（楽観的メッセージ用）。既存の自分の投稿から引く。 */
    const myName = () =>
      messages.find((m) => m.authorId === userId && m.kind !== "edit")
        ?.authorName ?? "自分";

    const messageList = () => {
      // 表示中のチャンネル宛ての送信中メッセージを末尾に合成する。SSE の
      // 再取得が POST 完了より先に同じ投稿をサーバから持ってきた場合は、
      // その分の送信中行を隠して一瞬の二重表示を防ぐ（本文が一致し時刻が
      // 近い自分の実メッセージ 1 件につき送信中行 1 件を消費する）。
      const pendingIds = new Set<string>();
      const all = [...messages];
      const consumed = new Set<string>();
      for (const p of pendingPosts) {
        if (p.threadId !== currentThreadId) continue;
        const real = messages.find((m) =>
          !consumed.has(m.id) && m.authorId === userId &&
          m.kind === "normal" && !m.deleted && m.body === p.body &&
          Math.abs(
              parseUtc(m.createdAt).getTime() - parseUtc(p.createdAt).getTime(),
            ) < 60_000
        );
        if (real) {
          consumed.add(real.id);
          continue;
        }
        pendingIds.add(p.id);
        all.push({
          id: p.id,
          authorId: userId ?? "",
          authorName: myName(),
          body: p.body,
          createdAt: p.createdAt,
          editedAt: null,
          kind: "normal",
          deleted: false,
          hidden: false,
          repost: null,
          stamp: null,
          quotedIn: [],
          reactions: [],
        });
      }
      const rows: ReturnType<typeof messageRow>[] = [];
      let prev: Message | null = null;
      for (const m of all) {
        const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
        if (newDay) {
          rows.push(
            <div
              key={`day-${m.id}`}
              class="divider mx-4 my-1 text-xs opacity-70"
            >
              {fmtDate(m.createdAt)}
            </div>,
          );
        }
        const grouped = !newDay && !!prev && prev.kind !== "edit" &&
          prev.authorId === m.authorId &&
          parseUtc(m.createdAt).getTime() -
                parseUtc(prev.createdAt).getTime() < GROUP_WINDOW_MS;
        rows.push(messageRow(m, grouped, pendingIds.has(m.id)));
        prev = m;
      }
      return rows.reverse();
    };

    /** picker のスタンプ 1 個（タップで送信）。 */
    const stampButton = (s: Stamp) => (
      <button
        type="button"
        key={s.id}
        class="p-1 rounded-lg hover:bg-base-200 active:bg-base-300"
        title={s.label}
        aria-label={`スタンプ「${s.label}」を送信`}
        mix={[on("click", () => onPostStamp(s.id))]}
      >
        {stampImg(s.storageKey, s.label, "h-14 w-full object-contain")}
      </button>
    );

    /**
     * スタンプ picker（composer 直上）。自分のライブラリと、ホームのメンバー
     * が持つ未所持スタンプを並べる。未所持を使うと自分のライブラリに自動追加
     * される（LRU で押し出し）。
     */
    const stampPicker = () => {
      const homeOnly = homeStamps.filter((s) => !s.inLibrary);
      return (
        <div class="mb-1 rounded-xl border border-base-300 bg-base-100 p-2 shadow-lg max-h-72 overflow-y-auto">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold opacity-60">
              マイスタンプ（{myStamps.length}/{MAX_LIBRARY_STAMPS}）
            </span>
            <label
              class={`btn btn-xs ${stampUploading ? "btn-disabled" : ""}`}
            >
              {stampUploading ? "アップロード中…" : "＋ 画像を追加"}
              <input
                type="file"
                accept="image/*"
                class="hidden"
                disabled={stampUploading}
                mix={[on<HTMLInputElement>("change", (e) => {
                  const input = e.target as HTMLInputElement;
                  const file = input.files?.[0];
                  input.value = "";
                  if (file) onUploadStamp(file);
                })]}
              />
            </label>
          </div>
          {myStamps.length === 0
            ? (
              <div class="p-2 text-xs opacity-60">
                まだスタンプがありません。「＋ 画像を追加」から登録できます（2MB
                まで）。
              </div>
            )
            : (
              <div class="grid grid-cols-4 sm:grid-cols-6 gap-1 mt-1">
                {myStamps.map(stampButton)}
              </div>
            )}
          {homeOnly.length > 0
            ? (
              <div>
                <div class="text-xs font-semibold opacity-60 mt-2">
                  ホームのスタンプ
                </div>
                <div class="grid grid-cols-4 sm:grid-cols-6 gap-1 mt-1">
                  {homeOnly.map(stampButton)}
                </div>
              </div>
            )
            : null}
        </div>
      );
    };

    /** 設定画面のスタンプライブラリ管理（削除・LRU の可視化）。 */
    const stampSettings = () => {
      const full = myStamps.length >= MAX_LIBRARY_STAMPS;
      return (
        <div>
          <label class="text-sm opacity-70">
            スタンプ（{myStamps.length}/{MAX_LIBRARY_STAMPS}）
          </label>
          <p class="text-xs opacity-60">
            最近使った順に並びます。上限を超えて新しいスタンプを使うと、一番
            使っていないものから自動的に外れます（画像は消えません）。
          </p>
          {myStamps.length === 0
            ? (
              <div class="text-xs opacity-50 mt-1">
                まだスタンプがありません。チャット入力欄の 🎴 から登録できます。
              </div>
            )
            : (
              <div class="grid grid-cols-4 sm:grid-cols-6 gap-2 mt-2">
                {myStamps.map((s, i) => (
                  <div
                    key={s.id}
                    class="relative rounded-lg border border-base-300 p-1"
                  >
                    {stampImg(
                      s.storageKey,
                      s.label,
                      "h-14 w-full object-contain",
                    )}
                    {full && i === myStamps.length - 1
                      ? (
                        <span
                          class="badge badge-warning badge-xs absolute -top-2 left-1"
                          title="次に新しいスタンプを使うとこれが消えます"
                        >
                          !
                        </span>
                      )
                      : null}
                    <button
                      type="button"
                      class="btn btn-xs btn-circle absolute -top-2 -right-2"
                      aria-label={`「${s.label}」をライブラリから外す`}
                      title="ライブラリから外す"
                      mix={[on("click", () => onRemoveStamp(s.id))]}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
        </div>
      );
    };

    /** サイドバーのチャンネル項目（Discord 風）。 */
    const channelItem = (
      threadId: string | null,
      label: string,
      icon = "#",
    ) => {
      const active = currentThreadId === threadId;
      return (
        <button
          type="button"
          key={threadId ?? "__main__"}
          class={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            active
              ? "bg-base-content/10 font-semibold"
              : "opacity-70 hover:bg-base-content/5 hover:opacity-100"
          }`}
          mix={[on("click", () => selectChannel(threadId))]}
        >
          <span class="shrink-0 w-4 text-center opacity-60 font-normal">
            {icon}
          </span>
          <span class="truncate flex-1">{label}</span>
        </button>
      );
    };

    const threadGroup = (label: string, list: Thread[], icon = "#") =>
      list.length === 0 ? [] : [
        <div
          key={`title-${label}`}
          class="px-2 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider opacity-50"
        >
          {label}
        </div>,
        ...list.map((t) => channelItem(t.id, t.title, icon)),
      ];

    const sidebar = () => (
      <aside class="chat-sidebar bg-base-300 w-72 h-full min-h-full flex flex-col">
        <div class="h-12 px-4 flex items-center justify-between gap-2 border-b border-base-content/10 shrink-0">
          <span class="font-bold truncate">{homeName || "ホーム"}</span>
          <a
            class="btn btn-ghost btn-xs btn-square opacity-70"
            href="/homes"
            aria-label="ホーム一覧へ"
            title="ホーム一覧へ"
          >
            ⌂
          </a>
        </div>
        <nav class="flex-1 overflow-y-auto px-2 py-2">
          {channelItem(null, "メイン")}
          {threadGroup(
            "参加中",
            threads.filter((t) => !t.archivedAt && t.joined),
          )}
          {threadGroup(
            "未参加",
            threads.filter((t) => !t.archivedAt && !t.joined),
          )}
          {threadGroup(
            "アーカイブ",
            threads.filter((t) => !!t.archivedAt),
            "🗄",
          )}
        </nav>
        <div class="p-2 border-t border-base-content/10 shrink-0">
          <button
            type="button"
            class="btn btn-ghost btn-sm w-full justify-start gap-2"
            aria-label="メニュー"
            mix={[on("click", openSettings)]}
          >
            <span class="opacity-70">⚙</span> 設定
          </button>
        </div>
      </aside>
    );

    const settingsOverlay = () => (
      <div class="fixed inset-0 z-30 bg-base-100 overflow-y-auto">
        <div class="max-w-2xl mx-auto p-4 space-y-6">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold">設定</h2>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label="閉じる"
              mix={[on("click", closeSettings)]}
            >
              ✕
            </button>
          </div>

          {error
            ? (
              <div role="alert" class="alert alert-error alert-soft">
                <span>{error}</span>
              </div>
            )
            : null}

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h3 class="card-title text-base">自分の設定</h3>
              <label class="text-sm opacity-70">このホームでの表示名</label>
              <div class="join">
                <input
                  class="input input-bordered input-sm join-item flex-1"
                  value={nameDraft}
                  mix={[on<HTMLInputElement>("input", (e) => {
                    nameDraft = (e.target as HTMLInputElement).value;
                    handle.update();
                  })]}
                />
                <button
                  type="button"
                  class="btn btn-sm btn-primary join-item"
                  mix={[on("click", onSaveName)]}
                >
                  保存
                </button>
              </div>
              <div class="mt-2">{stampSettings()}</div>
              <div class="text-sm opacity-50 mt-2">
                MCP 連携の設定（未実装）
              </div>
            </div>
          </div>

          {role === "admin"
            ? (
              <div class="card card-border bg-base-100">
                <div class="card-body">
                  <div class="flex items-center justify-between">
                    <h3 class="card-title text-base">ホームの設定</h3>
                    <button
                      type="button"
                      class={`btn btn-sm ${
                        homeSettingsOpen ? "btn-active" : ""
                      }`}
                      mix={[on("click", () => {
                        homeSettingsOpen = !homeSettingsOpen;
                        handle.update();
                      })]}
                    >
                      {homeSettingsOpen ? "閉じる" : "開く"}
                    </button>
                  </div>
                  {homeSettingsOpen ? homeSettings() : null}
                </div>
              </div>
            )
            : null}
        </div>
      </div>
    );

    /** The live invite: URL + scannable QR, valid while this screen is open. */
    const inviteCard = () => {
      const url = inviteUrl();
      const { size, d } = qrPath(url);
      const margin = 2;
      const total = size + margin * 2;
      return (
        <div class="rounded-box border border-base-300 bg-base-100 p-3 space-y-3">
          <p class="text-xs opacity-60">
            この画面を開いている間だけ有効な招待リンクです。相手のスマホで QR
            を読み取るか、リンクを共有してください。
          </p>
          <div class="flex justify-center">
            <svg
              viewBox={`0 0 ${total} ${total}`}
              class="w-44 h-44 rounded bg-white"
              shape-rendering="crispEdges"
              aria-label="招待QRコード"
            >
              <path
                transform={`translate(${margin} ${margin})`}
                d={d}
                fill="#000"
              />
            </svg>
          </div>
          <div class="join w-full">
            <input
              class="input input-bordered input-sm join-item flex-1 font-mono text-xs"
              readonly
              value={url}
              mix={[on("focus", (e) => {
                (e.target as HTMLInputElement).select();
              })]}
            />
            <button
              type="button"
              class="btn btn-sm join-item"
              mix={[on("click", onCopyInvite)]}
            >
              {inviteCopied ? "コピー済み ✓" : "コピー"}
            </button>
          </div>
          <div class="text-right">
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              mix={[on("click", onCloseInvite)]}
            >
              招待を終了
            </button>
          </div>
        </div>
      );
    };

    const homeSettings = () => (
      <div class="space-y-4 mt-2">
        <div>
          <div class="flex items-center gap-2">
            <input
              class="input input-bordered input-sm flex-1"
              placeholder="追加するユーザーの userId"
              value={addUserId}
              mix={[on<HTMLInputElement>("input", (e) => {
                addUserId = (e.target as HTMLInputElement).value;
                handle.update();
              })]}
            />
            <button
              type="button"
              class="btn btn-sm"
              mix={[on("click", onAddMember)]}
            >
              メンバー追加
            </button>
          </div>
          <div class="mt-2">
            {inviteToken ? inviteCard() : (
              <button
                type="button"
                class="btn btn-sm btn-outline"
                mix={[on("click", onInvite)]}
              >
                招待リンクを発行
              </button>
            )}
          </div>
        </div>

        <table class="table table-sm">
          <thead>
            <tr>
              <th>ユーザー</th>
              <th>ロール</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{members.map(memberRow)}</tbody>
        </table>

        <div>
          <h4 class="font-semibold text-sm">テーマ（カスタム CSS）</h4>
          <p class="text-xs opacity-60">
            url() や @import などのネットワーク取得は保存時に無効化されます。
          </p>
          <textarea
            class="textarea textarea-bordered font-mono text-sm w-full"
            rows={4}
            placeholder=".chat-msg:hover { background: #fde; }"
            value={themeDraft}
            mix={[on<HTMLTextAreaElement>("input", (e) => {
              themeDraft = (e.target as HTMLTextAreaElement).value;
              handle.update();
            })]}
          >
          </textarea>
          <button
            type="button"
            class="btn btn-sm btn-primary mt-1"
            mix={[on("click", onSaveTheme)]}
          >
            テーマを保存
          </button>
        </div>
      </div>
    );

    const memberRow = (m: Member) => {
      const canManage = role === "admin" && m.userId !== userId;
      return (
        <tr key={m.userId}>
          <td>
            {m.displayName}
            {m.isAgent ? <span class="badge badge-xs ml-1">agent</span> : null}
            <div class="text-xs opacity-60">{m.userId}</div>
          </td>
          <td>
            <span
              class={`badge badge-sm ${
                m.role === "admin" ? "badge-primary" : "badge-ghost"
              }`}
            >
              {m.role}
            </span>
          </td>
          <td class="text-right">
            {canManage
              ? (
                <div class="join">
                  <button
                    type="button"
                    class="btn btn-xs join-item"
                    mix={[on("click", () =>
                      onSetRole(
                        m.userId,
                        m.role === "admin" ? "member" : "admin",
                      ))]}
                  >
                    {m.role === "admin" ? "member に" : "admin に"}
                  </button>
                  <button
                    type="button"
                    class="btn btn-xs btn-error join-item"
                    mix={[on("click", () => onRemoveMember(m.userId))]}
                  >
                    削除
                  </button>
                </div>
              )
              : null}
          </td>
        </tr>
      );
    };

    /**
     * 長押しで開くコンテキストメニュー（下からせり上がるボトムシート）。
     * リアクション・返信・編集・削除を 1 か所に集約する。scrim は開いた
     * 直後（合成 click 対策の時間ガード内）はクリックを無視する。
     */
    const contextSheet = () => {
      const m = messages.find((x) => x.id === menuFor);
      if (!m || m.deleted || m.kind === "edit") return null;
      const mine = m.authorId === userId;
      const canDelete = mine || role === "admin";
      const emojis = [...new Set([...recentEmojis, ...DEFAULT_EMOJIS])].slice(
        0,
        6,
      );
      const act = (fn: () => void) => {
        closeMenu();
        fn();
      };
      return (
        <div
          class="fixed inset-0 z-40 flex flex-col justify-end"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            class="context-scrim absolute inset-0 bg-black/40"
            aria-label="閉じる"
            mix={[on("click", () => {
              if (Date.now() - menuOpenedAt < 500) return;
              closeMenu();
            })]}
          >
          </button>
          <div class="context-sheet relative w-full max-w-md mx-auto bg-base-100 rounded-t-2xl shadow-2xl pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <div class="flex justify-center pt-2 pb-1">
              <div class="h-1 w-10 rounded-full bg-base-content/20"></div>
            </div>
            {archived()
              ? null
              : (
                <div class="flex justify-around gap-1 px-3 py-2">
                  {emojis.map((e) => (
                    <button
                      type="button"
                      key={e}
                      class="w-11 h-11 rounded-full text-2xl flex items-center justify-center hover:bg-base-200 active:bg-base-300"
                      mix={[
                        on("click", () => act(() => onToggleReaction(m.id, e))),
                      ]}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            <ul class="menu w-full text-base pb-1">
              <li>
                <a
                  mix={[
                    on("click", () => act(() => onPickupToNewThread(m.id))),
                  ]}
                >
                  <span class="w-6 text-center">↩︎</span> スレッドで返信
                </a>
              </li>
              {!archived() && mine && m.kind === "normal"
                ? (
                  <li>
                    <a
                      mix={[on("click", () => act(() => onEdit(m.id, m.body)))]}
                    >
                      <span class="w-6 text-center">✏️</span> メッセージを編集
                    </a>
                  </li>
                )
                : null}
              {!archived() && canDelete
                ? (
                  <li>
                    <a
                      class="text-error"
                      mix={[on("click", () => act(() => onDelete(m.id)))]}
                    >
                      <span class="w-6 text-center">🗑</span> 削除
                    </a>
                  </li>
                )
                : null}
            </ul>
          </div>
        </div>
      );
    };

    // Redirect straight to the IdP, asking it to return to this same page
    // (the chat view) once the passkey sign-in completes. The DPoP thumbprint
    // binds the resulting IdP session to this browser's key.
    const onSignin = () => {
      const params = new URLSearchParams({
        dpop_jkt: thumbprint,
        redirect_uri: globalThis.location.href,
      });
      globalThis.location.href =
        `${handle.props.idpOrigin}/authorize?${params.toString()}`;
    };

    return () => {
      if (!ready) {
        return <div class="alert alert-soft m-4">読み込み中…</div>;
      }
      if (!userId) {
        return (
          <div class="hero min-h-[100dvh]">
            <div class="hero-content text-center">
              <div>
                <p class="mb-4">チャットを使うにはサインインが必要です。</p>
                <button
                  type="button"
                  class="btn btn-primary"
                  mix={[on("click", onSignin)]}
                >
                  パスキーでサインイン
                </button>
              </div>
            </div>
          </div>
        );
      }
      return (
        <div class="drawer lg:drawer-open h-[100dvh]">
          {settingsOpen ? settingsOverlay() : null}
          {menuFor ? contextSheet() : null}
          <input id={DRAWER_ID} type="checkbox" class="drawer-toggle" />
          {
            /* daisyUI の drawer は grid のため、h-full だと grid トラックが
              中身の高さまで伸びて composer が画面外へ押し出される。ビュー
              ポート高で固定し、メッセージ一覧を内部スクロールに閉じ込める
              ことで composer を下端に貼り付ける。 */
          }
          <div class="drawer-content flex flex-col min-w-0 h-[100dvh]">
            <header class="h-12 flex items-center gap-2 px-3 border-b border-base-300 shadow-sm shrink-0">
              <label
                for={DRAWER_ID}
                class="btn btn-ghost btn-sm btn-square drawer-button lg:hidden"
                aria-label="スレッド一覧"
              >
                ☰
              </label>
              <h2 class="font-bold truncate flex-1">
                <span class="opacity-40 font-normal mr-1">
                  {currentThreadId ? "🧵" : "#"}
                </span>
                {channelName()}
              </h2>
              {currentThreadId &&
                  (currentThread()?.createdBy === userId || role === "admin")
                ? (
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    aria-label="スレッド名を編集"
                    mix={[on("click", () =>
                      onRenameThread(
                        currentThreadId!,
                        currentThread()?.title ?? "",
                      ))]}
                  >
                    ✏️
                  </button>
                )
                : null}
              {archived()
                ? <span class="badge badge-sm">アーカイブ（読み取り専用）</span>
                : null}
              {currentThreadId && currentThread()?.joined && !archived()
                ? (
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    mix={[on("click", () => onLeave(currentThreadId!))]}
                  >
                    退出
                  </button>
                )
                : null}
            </header>

            {error
              ? (
                <div role="alert" class="alert alert-error alert-soft m-2">
                  <span>{error}</span>
                </div>
              )
              : null}

            <div class="chat-messages flex-1 min-h-0 overflow-y-auto flex flex-col-reverse py-2">
              {messages.length === 0 &&
                  !pendingPosts.some((p) => p.threadId === currentThreadId)
                ? (
                  <div class="flex-1 flex items-center justify-center opacity-60">
                    まだメッセージがありません。
                  </div>
                )
                : messageList()}
            </div>

            {archived()
              ? (
                <div class="alert alert-soft m-2">
                  <span>
                    このスレッドはアーカイブ済みです（読み取り専用）。
                  </span>
                </div>
              )
              : (
                <div class="chat-composer px-3 pb-3 pt-1 shrink-0">
                  {editingId
                    ? (
                      <div class="mb-1 px-1">
                        <div class="flex items-center gap-1 text-sm">
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs btn-circle"
                            aria-label="編集をやめる"
                            title="編集をやめる"
                            mix={[on("click", cancelEdit)]}
                          >
                            ✕
                          </button>
                          <span class="font-semibold">メッセージの編集</span>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs btn-circle"
                            aria-label="説明"
                            title="説明"
                            mix={[on("click", () => {
                              editInfoOpen = !editInfoOpen;
                              handle.update();
                            })]}
                          >
                            ⓘ
                          </button>
                        </div>
                        {editInfoOpen
                          ? (
                            <div class="mt-1 rounded-lg bg-base-200 p-2 text-xs opacity-80">
                              編集したメッセージは新規投稿となります。
                            </div>
                          )
                          : null}
                      </div>
                    )
                    : null}
                  {stampPickerOpen && !editingId ? stampPicker() : null}
                  <div
                    class={`flex items-center gap-1 rounded-xl border bg-base-100 px-2 py-1 shadow-sm transition-colors ${
                      editingId
                        ? "border-warning"
                        : "border-base-300 focus-within:border-base-content/40"
                    }`}
                  >
                    <input
                      id={COMPOSER_INPUT_ID}
                      class="flex-1 min-w-0 bg-transparent border-0 outline-none px-2 py-2"
                      placeholder={editingId
                        ? "メッセージを編集…"
                        : `#${channelName()} へメッセージを送信`}
                      value={newMessage}
                      mix={[
                        on<HTMLInputElement>("input", (e) => {
                          newMessage = (e.target as HTMLInputElement).value;
                          handle.update();
                        }),
                        on("keydown", (e) => {
                          // IME 変換確定の Enter（isComposing）では送信しない。
                          if (e.key === "Enter" && !e.isComposing) {
                            e.preventDefault();
                            onPost();
                          } else if (e.key === "Escape" && editingId) {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }),
                      ]}
                    />
                    {!editingId
                      ? (
                        <button
                          type="button"
                          class={`btn btn-ghost btn-sm btn-circle ${
                            stampPickerOpen ? "btn-active" : ""
                          }`}
                          aria-label="スタンプ"
                          title="スタンプ"
                          mix={[
                            on("pointerdown", (e) => e.preventDefault()),
                            on("click", toggleStampPicker),
                          ]}
                        >
                          🎴
                        </button>
                      )
                      : null}
                    <button
                      type="button"
                      class="btn btn-primary btn-sm btn-circle"
                      aria-label={editingId ? "更新" : "送信"}
                      title={editingId ? "更新" : "送信"}
                      disabled={!newMessage.trim()}
                      mix={[
                        // タップ/クリックで入力欄からフォーカスを奪わない
                        // （スマホのキーボードが閉じないように）。click は
                        // pointerdown を打ち消しても発火する。
                        on("pointerdown", (e) => e.preventDefault()),
                        on("click", onPost),
                      ]}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M3.4 20.4l17.4-7.5c.8-.35.8-1.45 0-1.8L3.4 3.6c-.66-.29-1.39.2-1.39.91l-.01 4.61c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
          </div>

          <div class="drawer-side z-10">
            <label for={DRAWER_ID} class="drawer-overlay" aria-label="閉じる">
            </label>
            {sidebar()}
          </div>
        </div>
      );
    };
  },
);
