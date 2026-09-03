/**
 * Document — the persistent HTML shell (nav + `<Frame name="content">`).
 *
 * Client-side, `run()` (bundled from client/mod.ts) turns clicks on
 * `<a data-rmx-target="content">` into frame reloads instead of full document
 * navigations.
 */

import { Frame, type Handle } from "@remix-run/ui";
import { NavAuth } from "../../client/nav_auth.tsx";
import { routes } from "../routes.ts";

type DocumentProps = {
  initialSrc: string;
  /** IdP origin, for the header's session probe (see NavAuth). */
  idpOrigin: string;
};

/**
 * The shell (landing / sign-in / home list) is fixed to daisyUI's `cupcake`.
 * Chat screens are bare documents (`renderBareDocument`) and keep the
 * default light/dark, so a home's custom CSS builds on a neutral base.
 */
const SHELL_THEME = "cupcake";

export function Document(handle: Handle<DocumentProps>) {
  return () => (
    <html lang="ja" data-theme={SHELL_THEME}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>home portal (ホムポタ)</title>
        <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=" />
        <script async type="module" src="/mod.js"></script>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body class="min-h-screen bg-base-100 text-base-content">
        <header class="navbar bg-base-200 shadow-sm">
          <div class="navbar-start">
            <a
              class="btn btn-ghost text-xl"
              href={routes.home.href()}
              data-rmx-target="content"
            >
              ホムポタ
            </a>
          </div>
          {
            /* Minimal top nav: the product's only global journey is
              landing → sign in → home list, so the header carries exactly one
              action — 「サインイン」 while signed out, 「ホーム一覧」 once in.
              All settings (members, theme, invites, agents, notifications)
              live inside each home. */
          }
          <nav class="navbar-end">
            <NavAuth idpOrigin={handle.props.idpOrigin} />
          </nav>
        </header>
        <Frame
          name="content"
          src={handle.props.initialSrc}
          fallback={
            <main class="mx-auto w-full max-w-3xl p-8">
              <p>Loading…</p>
            </main>
          }
        />
      </body>
    </html>
  );
}
