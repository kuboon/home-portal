/**
 * Render helpers for shell + frame content.
 *
 * `renderPage(context, fragment)` emits:
 *   - just the fragment, when the request carries the `rmx-frame: 1` header
 *     (set by both the server-side `resolveFrame` below and the client-side
 *     `run()` in reference/client/hydration.ts);
 *   - the full {@link Document} shell otherwise, with the current URL as the
 *     initial frame src. The shell's server-side `resolveFrame` dispatches
 *     back into the same router to fetch the fragment.
 */

import type { RemixNode } from "@remix-run/ui";
import { renderToStream } from "@remix-run/ui/server";
import type { RequestContext, Router } from "@remix-run/fetch-router";
import { createHtmlResponse } from "@remix-run/response/html";

import { routes } from "../routes.ts";
import { Document } from "../ui/document.tsx";
import { BASE_100_DARK, BASE_100_LIGHT } from "../ui/theme_colors.ts";

export const FRAME_HEADER = "rmx-frame";

const idpOrigin = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

export const isFrameRequest = (request: Request): boolean =>
  request.headers.get(FRAME_HEADER) === "1";

export function renderFragment(body: RemixNode, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
  }
  return new Response(renderToStream(body), { ...init, headers });
}

export function renderPage(
  context: RequestContext,
  fragment: RemixNode,
): Response {
  if (isFrameRequest(context.request)) {
    return renderFragment(fragment);
  }
  return renderShell(context);
}

/**
 * Render a standalone, full-screen document (no nav shell) hosting a
 * clientEntry. Used for the chat landing page (`/home/:id`), which is a
 * navbar-less app screen rather than a fragment in the shared shell.
 *
 * `title` is used both as the document `<title>` and as the iOS
 * `apple-mobile-web-app-title` so an "add to home screen" icon is labelled
 * with it (e.g. the home name). `headExtra` lets the caller inject extra
 * `<head>` nodes such as a per-home `<link rel="manifest">`.
 */
export function renderBareDocument(
  title: string,
  body: RemixNode,
  headExtra?: RemixNode,
): Response {
  const doc = (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        {
          /* ステータスバーに塗る色の宣言。これが無いと iOS 26 以降の
            standalone でシステムがすりガラスを敷き、ヘッダーがぼける。
            media 付きを先に並べ、media 無しは最後（常に一致するため）。
            チャット画面は data-theme を持たず OS の light/dark に従う。 */
        }
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={BASE_100_LIGHT}
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content={BASE_100_DARK}
        />
        <meta name="theme-color" content={BASE_100_LIGHT} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* 明示的に不透明。black-translucent はすりガラスを呼び込む。 */}
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content={title} />
        <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=" />
        {headExtra}
        <script async type="module" src="/mod.js"></script>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body class="bg-base-100 text-base-content">{body}</body>
    </html>
  );
  return createHtmlResponse(renderToStream(doc));
}

export function renderShell(context: RequestContext): Response {
  const { request, router } = context;
  const url = new URL(request.url);
  const initialSrc = url.pathname === "/"
    ? routes.welcome.href()
    : url.pathname + url.search;

  const stream = renderToStream(
    <Document initialSrc={initialSrc} idpOrigin={idpOrigin} />,
    {
      frameSrc: request.url,
      resolveFrame: (src, target, frameContext) =>
        resolveFrameViaRouter(router, request, src, target, frameContext),
    },
  );
  return createHtmlResponse(stream);
}

async function resolveFrameViaRouter(
  router: Router,
  request: Request,
  src: string,
  target?: string,
  frameContext?: { currentFrameSrc?: string },
) {
  const base = frameContext?.currentFrameSrc ?? request.url;
  const url = new URL(src, base);

  const headers = new Headers({
    accept: "text/html",
    [FRAME_HEADER]: "1",
  });
  if (target) headers.set("rmx-target", target);

  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  const response = await router.fetch(
    new Request(url, { method: "GET", headers, signal: request.signal }),
  );
  return response.body!;
}
