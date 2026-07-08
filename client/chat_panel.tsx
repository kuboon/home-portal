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
import { ensureSession, type FetchDpop } from "./session.ts";

export interface ChatPanelProps {
  idpOrigin: string;
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

interface Message {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  kind: "normal" | "repost" | "edit";
  deleted: boolean;
  hidden: boolean;
  repost: { authorName: string; body: string; deleted: boolean } | null;
  quotedIn: { threadId: string; title: string }[];
  reactions: { emoji: string; count: number; mine: boolean }[];
}

const DEFAULT_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"];
const DRAWER_ID = "chat-drawer";

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
    let recentEmojis: string[] = [];
    let paletteFor: string | null = null;
    let quotesFor: string | null = null;
    let fetchDpop: FetchDpop | null = null;
    let streamAbort: AbortController | null = null;
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
        const title = globalThis.prompt("返信スレッドのタイトル", "");
        if (title == null || !title.trim()) return;
        const data = await api(`/api/homes/${homeId}/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
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
    };

    const onInvite = () =>
      run(async () => {
        const data = await api(`/api/homes/${homeId}/invite`, {
          method: "POST",
        }) as { token: string };
        inviteToken = data.token;
        if (inviteTimer !== null) clearInterval(inviteTimer);
        inviteTimer = setInterval(() => {
          if (inviteToken && fetchDpop) {
            fetchDpop(`/api/invites/${inviteToken}/heartbeat`, {
              method: "POST",
            }).catch(() => {});
          }
        }, 20_000);
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

    const onPost = () =>
      run(async () => {
        const body = newMessage.trim();
        if (!body) return;
        await api(`${channelBase()}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        newMessage = "";
        await loadMessages();
      });

    const onEdit = (messageId: string, current: string) =>
      run(async () => {
        const next = globalThis.prompt("メッセージを編集", current);
        if (next == null) return;
        const body = next.trim();
        if (!body) return;
        await api(`/api/messages/${messageId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        await loadMessages();
      });

    const onDelete = (messageId: string) =>
      run(async () => {
        if (!globalThis.confirm("このメッセージを削除しますか？")) return;
        await api(`/api/messages/${messageId}`, { method: "DELETE" });
        await loadMessages();
      });

    const onToggleReaction = (messageId: string, emoji: string) =>
      run(async () => {
        paletteFor = null;
        await api(`/api/messages/${messageId}/reactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        });
        await loadMessages();
        await loadRecentEmojis();
      });

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
          if (userId) {
            await loadHome();
            await loadThreads();
            await loadMessages();
            await loadRecentEmojis();
            startStream(currentThreadId);
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
    const messageRow = (m: Message, grouped: boolean) => {
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
      return (
        <div
          key={m.id}
          class={`chat-msg group relative flex gap-3 px-4 py-0.5 hover:bg-base-200/60 ${
            grouped ? "" : "mt-2"
          }`}
        >
          {grouped
            ? (
              <div class="w-9 shrink-0 text-right select-none">
                <time class="invisible group-hover:visible text-[10px] leading-6 opacity-50">
                  {fmtTime(m.createdAt)}
                </time>
              </div>
            )
            : avatar(m)}
          <div class="flex-1 min-w-0">
            {grouped ? null : (
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="font-bold leading-tight">{m.authorName}</span>
                <time class="text-xs opacity-50">{fmtTime(m.createdAt)}</time>
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
                    : m.repost.body}
                </div>
              )
              : null}
            {!m.deleted
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
          {m.deleted
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
                {!archived() && mine
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
    const messageList = () => {
      const rows: ReturnType<typeof messageRow>[] = [];
      let prev: Message | null = null;
      for (const m of messages) {
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
        rows.push(messageRow(m, grouped));
        prev = m;
      }
      return rows.reverse();
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
              <div class="text-sm opacity-50 mt-2">
                スタンプの設定（未実装）
              </div>
              <div class="text-sm opacity-50">MCP 連携の設定（未実装）</div>
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
            {inviteToken
              ? (
                <div class="alert alert-soft items-center gap-2">
                  <span class="text-sm">
                    招待コード（この画面を開いている間有効）:{" "}
                    <code>{inviteToken}</code>
                  </span>
                  <button
                    type="button"
                    class="btn btn-xs"
                    mix={[on("click", onCloseInvite)]}
                  >
                    閉じる
                  </button>
                </div>
              )
              : (
                <button
                  type="button"
                  class="btn btn-sm btn-outline"
                  mix={[on("click", onInvite)]}
                >
                  招待コードを発行
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
          <input id={DRAWER_ID} type="checkbox" class="drawer-toggle" />
          <div class="drawer-content flex flex-col min-w-0 h-full">
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

            <div class="chat-messages flex-1 overflow-y-auto flex flex-col-reverse py-2">
              {messages.length === 0
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
                  <div class="flex items-center gap-1 rounded-xl border border-base-300 bg-base-100 px-2 py-1 shadow-sm focus-within:border-base-content/40 transition-colors">
                    <input
                      class="flex-1 min-w-0 bg-transparent border-0 outline-none px-2 py-2"
                      placeholder={`#${channelName()} へメッセージを送信`}
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
                          }
                        }),
                      ]}
                    />
                    <button
                      type="button"
                      class="btn btn-primary btn-sm btn-circle"
                      aria-label="送信"
                      title="送信"
                      disabled={!newMessage.trim()}
                      mix={[on("click", onPost)]}
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
