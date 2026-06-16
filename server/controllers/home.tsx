/**
 * GET / — renders the shell (nav + `<Frame name="content">`).
 * The frame starts on /welcome (the landing fragment).
 */

import type { BuildAction } from "@remix-run/fetch-router";
import type { routes } from "../routes.ts";
import { renderShell } from "../utils/render.tsx";

export const homeAction = {
  handler(context) {
    return renderShell(context);
  },
} satisfies BuildAction<"GET", typeof routes.home>;
