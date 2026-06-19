/**
 * NotificationsCard — a @remix-run/ui `clientEntry` for /notifications.
 *
 * Manages Web Push device subscriptions via the IdP (id.kbn.one) push API,
 * which is CORS-enabled and DPoP-authenticated. The service worker (/sw.js,
 * same origin) receives pushes the IdP sends with its VAPID key.
 *
 * Subscriptions are stored at the IdP under the signed-in user; later, the
 * home portal server triggers sends through the IdP. Here we only register/
 * list/remove devices and send the user a test notification.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/ui";
import { ensureSession, type FetchDpop } from "./session.ts";

export interface NotificationsCardProps {
  idpOrigin: string;
  [key: string]: SerializableValue;
}

interface Device {
  id: string;
  endpoint: string;
  metadata?: { deviceName?: string };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceName(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("iphone")) return "iPhone";
  if (ua.includes("ipad")) return "iPad";
  if (ua.includes("android")) return "Android";
  if (ua.includes("windows")) return "Windows PC";
  if (ua.includes("mac os")) return "Mac";
  if (ua.includes("linux")) return "Linux";
  return "このデバイス";
}

function collectMetadata() {
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch { /* ignore */ }
  return {
    deviceName: deviceName(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    timezone,
  };
}

export const NotificationsCard = clientEntry(
  "/notifications_card.js#NotificationsCard",
  function NotificationsCard(handle: Handle<NotificationsCardProps>) {
    let ready = false;
    let signedIn = false;
    let supported = false;
    let permission: NotificationPermission = "default";
    let busy = false;
    let status = "";
    let statusVariant: "info" | "success" | "error" | "" = "";
    let devices: Device[] = [];
    let fetchDpop: FetchDpop | null = null;

    const idp = handle.props.idpOrigin;
    const setStatus = (
      message: string,
      variant: "info" | "success" | "error" | "" = "",
    ) => {
      status = message;
      statusVariant = variant;
    };

    const api = async (path: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetchDpop!(`${idp}${path}`, init);
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          (data as { message?: string }).message ?? response.statusText,
        );
      }
      return data;
    };

    const loadDevices = async () => {
      const data = await api("/push/subscriptions") as {
        subscriptions: Device[];
      };
      devices = data.subscriptions;
    };

    const run = (fn: () => Promise<void>) => async () => {
      if (busy) return;
      busy = true;
      setStatus("");
      handle.update();
      try {
        await fn();
      } catch (e) {
        setStatus((e as Error).message, "error");
      } finally {
        busy = false;
        handle.update();
      }
    };

    const onSubscribe = run(async () => {
      if (!supported) {
        throw new Error("このブラウザーは通知に対応していません。");
      }
      permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("通知が許可されませんでした。");
      }
      await navigator.serviceWorker.register("/sw.js");
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api("/push/vapid-key") as {
        publicKey: string;
      };
      const sub = await reg.pushManager.getSubscription() ??
        await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(
            publicKey,
          ) as BufferSource,
        });
      await api("/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          metadata: collectMetadata(),
        }),
      });
      await loadDevices();
      setStatus("この端末で通知を有効化しました。", "success");
    });

    const onTest = (id: string) =>
      run(async () => {
        await api("/push/notifications/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscriptionId: id }),
        });
        setStatus("テスト通知を送信しました。", "success");
      })();

    const onRemove = (id: string) =>
      run(async () => {
        await api(`/push/subscriptions/${id}`, { method: "DELETE" });
        await loadDevices();
      })();

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const session = await ensureSession(idp);
          fetchDpop = session.fetchDpop;
          signedIn = !!session.userId;
          supported = "serviceWorker" in navigator &&
            "PushManager" in globalThis && "Notification" in globalThis;
          if (supported) permission = Notification.permission;
          if (signedIn) await loadDevices();
        } catch (e) {
          setStatus((e as Error).message, "error");
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    return () => {
      if (!ready) return <div class="alert alert-soft">読み込み中…</div>;
      if (!signedIn) {
        return (
          <div class="alert alert-soft">
            <span>
              通知設定にはサインインが必要です。{" "}
              <a class="link" href="/signin" rmx-target="content">サインイン</a>
            </span>
          </div>
        );
      }
      const alertClass = statusVariant
        ? `alert alert-${statusVariant} alert-soft`
        : "alert alert-soft";
      return (
        <div class="space-y-4">
          {status
            ? (
              <div role="alert" class={alertClass}>
                <span>{status}</span>
              </div>
            )
            : null}
          {!supported
            ? (
              <p class="opacity-70">
                このブラウザーは Web Push に対応していません。
              </p>
            )
            : (
              <button
                type="button"
                class="btn btn-primary"
                disabled={busy}
                mix={[on("click", onSubscribe)]}
              >
                この端末で通知を有効化
              </button>
            )}
          <div class="card card-border bg-base-100">
            <div class="card-body">
              <h2 class="card-title">登録済みの端末</h2>
              {devices.length === 0
                ? <p class="opacity-70">まだ登録された端末はありません。</p>
                : (
                  <ul class="divide-y divide-base-200">
                    {devices.map((d) => (
                      <li class="flex items-center justify-between py-2">
                        <span>{d.metadata?.deviceName ?? "端末"}</span>
                        <span class="join">
                          <button
                            type="button"
                            class="btn btn-xs join-item"
                            disabled={busy}
                            mix={[on("click", () => onTest(d.id))]}
                          >
                            テスト
                          </button>
                          <button
                            type="button"
                            class="btn btn-xs btn-error join-item"
                            disabled={busy}
                            mix={[on("click", () => onRemove(d.id))]}
                          >
                            削除
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        </div>
      );
    };
  },
);
