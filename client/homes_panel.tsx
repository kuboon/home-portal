/**
 * HomesPanel — a @remix-run/ui `clientEntry` for the /homes page.
 *
 * Loads the signed-in user's homes via DPoP-protected `/api/homes`, and lets
 * them create a home and (as an admin) manage members: add by userId, change
 * role, remove. All requests are signed with `fetchDpop` from `ensureSession`.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { ensureSession, type FetchDpop } from "./session.ts";

export interface HomesPanelProps {
  idpOrigin: string;
  [key: string]: SerializableValue;
}

interface HomeWithRole {
  id: string;
  name: string;
  role: "admin" | "member";
  themeCss: string;
}

interface Member {
  userId: string;
  displayName: string;
  isAgent: boolean;
  role: "admin" | "member";
}

export const HomesPanel = clientEntry(
  "/homes_panel.js#HomesPanel",
  function HomesPanel(handle: Handle<HomesPanelProps>) {
    let ready = false;
    let userId: string | null = null;
    let error = "";
    let homes: HomeWithRole[] = [];
    let selectedId: string | null = null;
    let members: Member[] = [];
    let newHomeName = "";
    let addUserId = "";
    let fetchDpop: FetchDpop | null = null;
    let inviteToken: string | null = null;
    let inviteTimer: ReturnType<typeof setInterval> | null = null;
    let joinCode = "";
    let themeDraft = "";

    /** Inject the selected home's custom CSS into a dedicated <style>. */
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

    const selectedRole = () => homes.find((h) => h.id === selectedId)?.role;

    /** Call a DPoP-protected JSON endpoint; throws on non-2xx with its error. */
    const api = async (
      path: string,
      init?: RequestInit,
    ): Promise<unknown> => {
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

    const loadHomes = async () => {
      const data = await api("/api/homes") as { homes: HomeWithRole[] };
      homes = data.homes;
    };

    const loadMembers = async (homeId: string) => {
      const data = await api(`/api/homes/${homeId}/members`) as {
        members: Member[];
      };
      members = data.members;
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

    const onCreate = () =>
      run(async () => {
        const name = newHomeName.trim();
        if (!name) return;
        const displayName =
          globalThis.prompt(`「${name}」での表示名`, userId ?? "") ?? "";
        await api("/api/homes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, displayName }),
        });
        newHomeName = "";
        await loadHomes();
      });

    const stopInviteHeartbeat = () => {
      if (inviteTimer !== null) {
        clearInterval(inviteTimer);
        inviteTimer = null;
      }
      inviteToken = null;
    };

    const onSelect = (homeId: string) =>
      run(async () => {
        stopInviteHeartbeat();
        selectedId = homeId;
        const home = homes.find((h) => h.id === homeId);
        themeDraft = home?.themeCss ?? "";
        applyTheme(themeDraft);
        await loadMembers(homeId);
      });

    const onSaveTheme = () =>
      run(async () => {
        if (!selectedId) return;
        const data = await api(`/api/homes/${selectedId}/theme`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ css: themeDraft }),
        }) as { themeCss: string };
        themeDraft = data.themeCss; // server-sanitized
        await loadHomes();
        applyTheme(themeDraft);
      });

    const onInvite = () =>
      run(async () => {
        if (!selectedId) return;
        const data = await api(`/api/homes/${selectedId}/invite`, {
          method: "POST",
        }) as { token: string };
        inviteToken = data.token;
        if (inviteTimer !== null) clearInterval(inviteTimer);
        // Keep the token alive while the invite is shown (design: 60s TTL).
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

    const onJoin = () =>
      run(async () => {
        const code = joinCode.trim();
        if (!code) return;
        const displayName =
          globalThis.prompt("このホームでの表示名", userId ?? "") ?? "";
        await api(`/api/invites/${code}/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName }),
        });
        joinCode = "";
        await loadHomes();
      });

    const onSetMyName = () =>
      run(async () => {
        if (!selectedId) return;
        const me = members.find((m) => m.userId === userId);
        const next = globalThis.prompt(
          "このホームでの表示名",
          me?.displayName ?? userId ?? "",
        );
        if (next == null) return;
        await api(`/api/homes/${selectedId}/name`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: next }),
        });
        await loadMembers(selectedId);
      });

    const onAddMember = () =>
      run(async () => {
        const uid = addUserId.trim();
        if (!uid || !selectedId) return;
        await api(`/api/homes/${selectedId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: uid }),
        });
        addUserId = "";
        await loadMembers(selectedId);
      });

    const onSetRole = (uid: string, role: "admin" | "member") =>
      run(async () => {
        await api(`/api/homes/${selectedId}/members/${uid}/role`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        await loadMembers(selectedId!);
        await loadHomes();
      });

    const onRemove = (uid: string) =>
      run(async () => {
        await api(`/api/homes/${selectedId}/members/${uid}`, {
          method: "DELETE",
        });
        await loadMembers(selectedId!);
      });

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const session = await ensureSession(handle.props.idpOrigin);
          fetchDpop = session.fetchDpop;
          userId = session.userId;
          if (userId) {
            await loadHomes();
          }
        } catch (e) {
          error = (e as Error).message;
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    const memberRow = (m: Member) => {
      const isAdmin = selectedRole() === "admin";
      const canManage = isAdmin && m.userId !== userId;
      return (
        <tr>
          <td>
            {m.displayName}
            {m.isAgent ? <span class="badge badge-sm ml-1">agent</span> : null}
            <div class="text-xs opacity-60">{m.userId}</div>
          </td>
          <td>
            <span
              class={`badge ${
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
                  {m.role === "member"
                    ? (
                      <button
                        type="button"
                        class="btn btn-xs join-item"
                        mix={[on("click", () => onSetRole(m.userId, "admin"))]}
                      >
                        admin に
                      </button>
                    )
                    : (
                      <button
                        type="button"
                        class="btn btn-xs join-item"
                        mix={[on("click", () => onSetRole(m.userId, "member"))]}
                      >
                        member に
                      </button>
                    )}
                  <button
                    type="button"
                    class="btn btn-xs btn-error join-item"
                    mix={[on("click", () => onRemove(m.userId))]}
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

    return () => {
      if (!ready) {
        return <div class="alert alert-soft">読み込み中…</div>;
      }
      if (!userId) {
        return (
          <div class="alert alert-soft">
            <span>
              Home を使うにはサインインが必要です。{" "}
              <a class="link" href="/signin" rmx-target="content">サインイン</a>
            </span>
          </div>
        );
      }
      return (
        <div class="space-y-6">
          {error
            ? (
              <div role="alert" class="alert alert-error alert-soft">
                <span>{error}</span>
              </div>
            )
            : null}

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h2 class="card-title">Home を作成</h2>
              <div class="join">
                <input
                  class="input input-bordered join-item"
                  placeholder="Home の名前"
                  value={newHomeName}
                  mix={[on<HTMLInputElement>("input", (e) => {
                    newHomeName = (e.target as HTMLInputElement).value;
                    handle.update();
                  })]}
                />
                <button
                  type="button"
                  class="btn btn-primary join-item"
                  mix={[on("click", onCreate)]}
                >
                  作成
                </button>
              </div>
            </div>
          </div>

          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h2 class="card-title">あなたの Home</h2>
              {homes.length === 0
                ? <p class="opacity-70">まだ Home がありません。</p>
                : (
                  <ul class="menu bg-base-200 rounded-box">
                    {homes.map((h) => (
                      <li>
                        <div class="flex items-center justify-between gap-2">
                          <a
                            class="flex-1 font-medium link link-hover"
                            href={`/home/${h.id}`}
                            rmx-target="content"
                          >
                            {h.name}
                            <span class="badge badge-sm ml-1">{h.role}</span>
                          </a>
                          <a
                            class="btn btn-primary btn-xs"
                            href={`/home/${h.id}`}
                            rmx-target="content"
                          >
                            開く
                          </a>
                          <button
                            type="button"
                            class={`btn btn-ghost btn-xs ${
                              selectedId === h.id ? "btn-active" : ""
                            }`}
                            mix={[on("click", () => onSelect(h.id))]}
                          >
                            管理
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              <div class="divider my-1"></div>
              <div class="join">
                <input
                  class="input input-bordered input-sm join-item"
                  placeholder="招待コードで参加"
                  value={joinCode}
                  mix={[on<HTMLInputElement>("input", (e) => {
                    joinCode = (e.target as HTMLInputElement).value;
                    handle.update();
                  })]}
                />
                <button
                  type="button"
                  class="btn btn-sm join-item"
                  mix={[on("click", onJoin)]}
                >
                  参加
                </button>
              </div>
            </div>
          </div>

          {selectedId
            ? (
              <div class="space-y-6">
                <div class="card card-border bg-base-100">
                  <div class="card-body">
                    <div class="flex items-center justify-between">
                      <h2 class="card-title">メンバー</h2>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        mix={[on("click", onSetMyName)]}
                      >
                        表示名を変更
                      </button>
                    </div>
                    {selectedRole() === "admin"
                      ? (
                        <div class="join">
                          <input
                            class="input input-bordered input-sm join-item"
                            placeholder="追加するユーザーの userId"
                            value={addUserId}
                            mix={[on<HTMLInputElement>("input", (e) => {
                              addUserId = (e.target as HTMLInputElement).value;
                              handle.update();
                            })]}
                          />
                          <button
                            type="button"
                            class="btn btn-sm join-item"
                            mix={[on("click", onAddMember)]}
                          >
                            メンバー追加
                          </button>
                        </div>
                      )
                      : null}
                    {selectedRole() === "admin"
                      ? (
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
                      )
                      : null}
                    <table class="table">
                      <thead>
                        <tr>
                          <th>ユーザー</th>
                          <th>ロール</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>{members.map(memberRow)}</tbody>
                    </table>
                  </div>
                </div>

                {selectedRole() === "admin"
                  ? (
                    <div class="card card-border bg-base-100">
                      <div class="card-body">
                        <h2 class="card-title">テーマ（カスタム CSS）</h2>
                        <p class="text-xs opacity-60">
                          url() や @import
                          などのネットワーク取得は保存時に無効化されます。
                        </p>
                        <textarea
                          class="textarea textarea-bordered font-mono text-sm"
                          rows={4}
                          placeholder=".chat-bubble { background: #fde; }"
                          value={themeDraft}
                          mix={[on<HTMLTextAreaElement>("input", (e) => {
                            themeDraft =
                              (e.target as HTMLTextAreaElement).value;
                            handle.update();
                          })]}
                        >
                        </textarea>
                        <div class="card-actions mt-2">
                          <button
                            type="button"
                            class="btn btn-sm btn-primary"
                            mix={[on("click", onSaveTheme)]}
                          >
                            テーマを保存
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                  : null}

                <div class="card card-border bg-base-100">
                  <div class="card-body">
                    <h2 class="card-title">チャット</h2>
                    <p class="opacity-70">
                      メインチャンネルとスレッドでの会話はチャット画面で行います。
                    </p>
                    <div class="card-actions">
                      <a
                        class="btn btn-primary"
                        href={`/home/${selectedId}`}
                        rmx-target="content"
                      >
                        このホームのチャットを開く →
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            )
            : null}
        </div>
      );
    };
  },
);
