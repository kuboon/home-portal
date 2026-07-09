/**
 * JoinPanel — the invite landing screen (`/join/:token`).
 *
 * Flow:
 *  1. On load, bootstrap the DPoP session and ask the IdP who we are.
 *  2. If already signed in, redeem the token immediately and go to the home.
 *  3. If not, show a card naming the home with an optional display-name field
 *     and a passkey button. Signing in redirects to the IdP and back here;
 *     the display name is stashed in localStorage across that round trip so it
 *     survives the redirect, then applied when the token is redeemed.
 *
 * The token is only live while the inviting admin keeps the invite screen open
 * (60s TTL kept alive by a heartbeat), so redemption can fail if they've since
 * closed it — we surface that as an expired-invite message.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { ensureSession, type FetchDpop } from "./session.ts";

export interface JoinPanelProps {
  idpOrigin: string;
  token: string;
  /** Home name resolved server-side (empty when the token is invalid). */
  homeName: string;
  /** Whether the token resolved to a home at page render time. */
  valid: boolean;
  [key: string]: SerializableValue;
}

export const JoinPanel = clientEntry(
  "/join_panel.js#JoinPanel",
  function JoinPanel(handle: Handle<JoinPanelProps>) {
    const { idpOrigin, token, homeName, valid } = handle.props;
    const nameKey = `join_name_${token}`;

    let ready = false;
    let joining = false;
    let done = false;
    let error = "";
    let thumbprint = "";
    let nameDraft = "";
    let fetchDpop: FetchDpop | null = null;

    const accept = async () => {
      joining = true;
      handle.update();
      try {
        const stored = (() => {
          try {
            return globalThis.localStorage?.getItem(nameKey) ?? "";
          } catch {
            return "";
          }
        })();
        const response = await fetchDpop!(`/api/invites/${token}/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stored ? { displayName: stored } : {}),
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(
            (data as { error?: string }).error ?? "参加に失敗しました",
          );
        }
        try {
          globalThis.localStorage?.removeItem(nameKey);
        } catch { /* ignore */ }
        const home = (data as { home?: { id: string } }).home;
        done = true;
        handle.update();
        if (home?.id) {
          globalThis.location.replace(`/home/${encodeURIComponent(home.id)}`);
        }
      } catch (e) {
        error = (e as Error).message;
        joining = false;
        handle.update();
      }
    };

    // Redirect to the IdP for passkey sign-in / sign-up, returning to this same
    // invite URL so we can redeem the token once signed in.
    const onSignin = () => {
      try {
        if (nameDraft.trim()) {
          globalThis.localStorage?.setItem(nameKey, nameDraft.trim());
        } else {
          globalThis.localStorage?.removeItem(nameKey);
        }
      } catch { /* ignore */ }
      const params = new URLSearchParams({
        dpop_jkt: thumbprint,
        redirect_uri: globalThis.location.href,
      });
      globalThis.location.href = `${idpOrigin}/authorize?${params.toString()}`;
    };

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const session = await ensureSession(idpOrigin);
          fetchDpop = session.fetchDpop;
          thumbprint = session.thumbprint;
          try {
            nameDraft = globalThis.localStorage?.getItem(nameKey) ?? "";
          } catch { /* ignore */ }
          if (session.userId && valid) {
            // Signed in and the token is live → join straight away.
            await accept();
          }
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
        return (
          <div class="hero min-h-[100dvh]">
            <div class="hero-content">読み込み中…</div>
          </div>
        );
      }
      const content = !valid
        ? (
          <div class="flex flex-col items-center gap-2">
            <h1 class="card-title text-xl">招待が無効か期限切れです</h1>
            <p class="opacity-70 text-sm">
              管理者に招待リンクの再発行を依頼してください。
            </p>
          </div>
        )
        : done
        ? (
          <div class="flex flex-col items-center gap-2">
            <h1 class="card-title text-xl">参加しました 🎉</h1>
            <p class="opacity-70 text-sm">「{homeName}」へ移動しています…</p>
          </div>
        )
        : joining
        ? (
          <div class="flex flex-col items-center gap-3">
            <span class="loading loading-spinner loading-lg"></span>
            <p class="opacity-70 text-sm">参加しています…</p>
          </div>
        )
        : (
          <div class="flex flex-col items-center gap-4 w-full">
            <div class="text-4xl">🏠</div>
            <h1 class="card-title text-xl">「{homeName}」への招待</h1>
            <p class="opacity-70 text-sm">
              パスキーでサインイン／新規登録すると、このホームに参加できます。
            </p>
            <div class="w-full text-left">
              <label class="text-sm opacity-70">表示名（任意）</label>
              <input
                class="input input-bordered w-full mt-1"
                placeholder="このホームでの表示名"
                value={nameDraft}
                mix={[on("input", (e) => {
                  nameDraft = (e.target as HTMLInputElement).value;
                  handle.update();
                })]}
              />
            </div>
            <button
              type="button"
              class="btn btn-primary w-full"
              mix={[on("click", onSignin)]}
            >
              パスキーで参加
            </button>
          </div>
        );
      return (
        <div class="hero min-h-[100dvh] bg-base-200">
          <div class="hero-content w-full max-w-md">
            <div class="card w-full bg-base-100 shadow-xl">
              <div class="card-body items-center text-center gap-4">
                {content}
                {error
                  ? (
                    <div role="alert" class="alert alert-error alert-soft">
                      <span>{error}</span>
                    </div>
                  )
                  : null}
              </div>
            </div>
          </div>
        </div>
      );
    };
  },
);
