/**
 * NavAuth — the shell header's one auth-aware action (a `clientEntry`).
 *
 * Signed out → 「サインイン」, signed in → 「ホーム一覧」. The shell is rendered
 * server-side without knowing the IdP session (a plain document request
 * carries no DPoP proof), so the state is probed in the browser via
 * id.kbn.one's `/session`, as `ensureSession` does — minus the users-row
 * sync, which the page's own panel already performs. `init()` converges
 * concurrent callers on one key, so probing alongside a panel is safe.
 */

import { init } from "@kuboon/dpop";
import {
  clientEntry,
  type Handle,
  type SerializableValue,
} from "@remix-run/ui";

export interface NavAuthProps {
  idpOrigin: string;
  [key: string]: SerializableValue;
}

export const NavAuth = clientEntry(
  "/nav_auth.js#NavAuth",
  function NavAuth(handle: Handle<NavAuthProps>) {
    let ready = false;
    let signedIn = false;

    if (typeof document !== "undefined") {
      (async () => {
        try {
          const { fetchDpop } = await init();
          const response = await fetchDpop(`${handle.props.idpOrigin}/session`);
          if (response.ok) {
            const data = await response.json() as { userId: string | null };
            signedIn = !!data.userId;
          }
        } catch {
          // Unreachable IdP = not signed in; the sign-in page explains more.
        } finally {
          ready = true;
          handle.update();
        }
      })();
    }

    return () => {
      // Reserve the slot until the probe answers so the header doesn't jump,
      // and never flash the wrong state at a signed-in visitor.
      if (!ready) {
        return (
          <span class="btn btn-ghost btn-sm invisible" aria-hidden="true">
            ホーム一覧
          </span>
        );
      }
      return signedIn
        ? (
          <a
            class="btn btn-ghost btn-sm"
            href="/homes"
            data-rmx-target="content"
          >
            ホーム一覧
          </a>
        )
        : (
          <a
            class="btn btn-primary btn-sm"
            href="/signin"
            data-rmx-target="content"
          >
            サインイン
          </a>
        );
    };
  },
);
