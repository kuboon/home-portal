/**
 * HomesPanel — a @remix-run/ui `clientEntry` for the /homes page.
 *
 * The home list is intentionally lean: it lists the homes the signed-in user
 * belongs to (open one to chat), and lets them create a home or join by an
 * invite code. Everything else — members, roles, invites, theme, agents,
 * notifications — is managed inside each home (the chat screen's settings), so
 * this screen stays a simple hub. All requests are signed with `fetchDpop`
 * from `ensureSession`.
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

export const HomesPanel = clientEntry(
  "/homes_panel.js#HomesPanel",
  function HomesPanel(handle: Handle<HomesPanelProps>) {
    let ready = false;
    let userId: string | null = null;
    let error = "";
    let homes: HomeWithRole[] = [];
    let newHomeName = "";
    let joinCode = "";
    let fetchDpop: FetchDpop | null = null;

    /** Call a DPoP-protected JSON endpoint; throws on non-2xx with its error. */
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

    const loadHomes = async () => {
      const data = await api("/api/homes") as { homes: HomeWithRole[] };
      homes = data.homes;
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

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const session = await ensureSession(handle.props.idpOrigin);
          fetchDpop = session.fetchDpop;
          userId = session.userId;
          if (userId) await loadHomes();
        } catch (e) {
          error = (e as Error).message;
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    return () => {
      if (!ready) {
        return <div class="alert alert-soft">読み込み中…</div>;
      }
      if (!userId) {
        return (
          <div class="alert alert-soft">
            <span>
              ホームを使うにはサインインが必要です。{" "}
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
              <h2 class="card-title">あなたのホーム</h2>
              {homes.length === 0
                ? (
                  <p class="opacity-70">
                    まだホームがありません。新しく作るか、招待コードで参加して
                    ください。
                  </p>
                )
                : (
                  <ul class="menu bg-base-200 rounded-box">
                    {homes.map((h) => (
                      <li>
                        <a
                          class="flex items-center justify-between gap-2"
                          href={`/home/${h.id}`}
                        >
                          <span class="flex-1 font-medium">
                            {h.name}
                            <span class="badge badge-sm ml-1">{h.role}</span>
                          </span>
                          <span class="btn btn-primary btn-xs">開く →</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              <p class="text-xs opacity-60 mt-2">
                メンバー・テーマ・招待などの設定は、各ホームを開いた先の 「⚙
                設定」で行います。
              </p>
            </div>
          </div>

          <div class="grid gap-6 sm:grid-cols-2">
            <div class="card card-border bg-base-100">
              <div class="card-body">
                <h2 class="card-title text-base">ホームを作成</h2>
                <div class="join">
                  <input
                    class="input input-bordered input-sm join-item flex-1"
                    placeholder="ホームの名前"
                    value={newHomeName}
                    mix={[on<HTMLInputElement>("input", (e) => {
                      newHomeName = (e.target as HTMLInputElement).value;
                      handle.update();
                    })]}
                  />
                  <button
                    type="button"
                    class="btn btn-primary btn-sm join-item"
                    mix={[on("click", onCreate)]}
                  >
                    作成
                  </button>
                </div>
                <p class="text-xs opacity-60">
                  作成すると、あなたが最初の管理者になります。
                </p>
              </div>
            </div>

            <div class="card card-border bg-base-100">
              <div class="card-body">
                <h2 class="card-title text-base">招待コードで参加</h2>
                <div class="join">
                  <input
                    class="input input-bordered input-sm join-item flex-1"
                    placeholder="招待コード"
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
                <p class="text-xs opacity-60">
                  招待リンクを開けば、コード入力なしで参加できます。
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    };
  },
);
