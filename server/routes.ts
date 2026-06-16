import { get, post, route } from "@remix-run/fetch-router/routes";

export const routes = route({
  home: get("/"),
  welcome: get("/welcome"),
  signin: get("/signin"),
  api: route("api", {
    /** DPoP-protected: returns the current session info. */
    me: get("/me"),
    /** DPoP-protected: records the signed-in IdP user into Turso. */
    syncUser: post("/users/sync"),
  }),
});
