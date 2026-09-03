/**
 * GET / — renders the shell (nav + `<Frame name="content">`).
 * The frame starts on /welcome (the landing fragment).
 */

import { createAction } from "@remix-run/fetch-router";
import { routes } from "../routes.ts";
import { renderShell } from "../utils/render.tsx";

export const homeAction = createAction(routes.home, {
  handler(context) {
    return renderShell(context);
  },
});
