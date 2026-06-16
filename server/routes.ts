import { del, get, post, route } from "@remix-run/fetch-router/routes";

export const routes = route({
  home: get("/"),
  welcome: get("/welcome"),
  signin: get("/signin"),
  homes: get("/homes"),
  api: route("api", {
    /** DPoP-protected: returns the current session info. */
    me: get("/me"),
    /** DPoP-protected: records the signed-in IdP user into Turso. */
    syncUser: post("/users/sync"),
  }),
  homesApi: route("api/homes", {
    /** GET /api/homes — homes the signed-in user belongs to. */
    list: get("/"),
    /** POST /api/homes — create a home (caller becomes admin). */
    create: post("/"),
    /** GET /api/homes/:homeId/members */
    members: get("/:homeId/members"),
    /** POST /api/homes/:homeId/members — add an existing user (admin only). */
    addMember: post("/:homeId/members"),
    /** POST /api/homes/:homeId/members/:userId/role — change role (admin). */
    setRole: post("/:homeId/members/:userId/role"),
    /** DELETE /api/homes/:homeId/members/:userId — remove member (admin). */
    removeMember: del("/:homeId/members/:userId"),
  }),
});
