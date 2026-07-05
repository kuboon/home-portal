import { del, get, post, route } from "@remix-run/fetch-router/routes";

export const routes = route({
  home: get("/"),
  welcome: get("/welcome"),
  signin: get("/signin"),
  homes: get("/homes"),
  /** Chat for a home (main channel). */
  homeChat: get("/home/:homeId"),
  /** Chat for a specific thread in a home. */
  homeThread: get("/home/:homeId/thread/:threadId"),
  /** Per-home PWA manifest so an A2HS icon is named after the home. */
  homeManifest: get("/home/:homeId/manifest.webmanifest"),
  agents: get("/agents"),
  notifications: get("/notifications"),
  /** Public JWKS so the IdP can verify our RP client assertions. */
  jwks: get("/.well-known/jwks.json"),
  /** MCP endpoint for agents (bearer-token auth, JSON-RPC). */
  mcp: post("/mcp"),
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
    /** POST /api/homes/:homeId/name — set the caller's per-home display name. */
    setName: post("/:homeId/name"),
    /** POST /api/homes/:homeId/members/:userId/role — change role (admin). */
    setRole: post("/:homeId/members/:userId/role"),
    /** DELETE /api/homes/:homeId/members/:userId — remove member (admin). */
    removeMember: del("/:homeId/members/:userId"),
    /** POST /api/homes/:homeId/invite — issue an invite token (admin). */
    invite: post("/:homeId/invite"),
    /** POST /api/homes/:homeId/theme — set the home's custom CSS (admin). */
    setTheme: post("/:homeId/theme"),
  }),
  agentsApi: route("api/agents", {
    /** GET /api/agents — the caller's agents. */
    list: get("/"),
    /** POST /api/agents — create an agent (returns its token once). */
    create: post("/"),
    /** DELETE /api/agents/:agentId — revoke an agent. */
    delete: del("/:agentId"),
  }),
  invitesApi: route("api/invites", {
    /** POST /api/invites/:token/heartbeat — keep the invite alive (admin). */
    heartbeat: post("/:token/heartbeat"),
    /** DELETE /api/invites/:token — close the invite (admin). */
    close: del("/:token"),
    /** POST /api/invites/:token/accept — join the home (signed-in user). */
    accept: post("/:token/accept"),
  }),
  threadsApi: route("api", {
    /** GET /api/homes/:homeId/threads — threads in a home (members). */
    list: get("/homes/:homeId/threads"),
    /** POST /api/homes/:homeId/threads — create a thread (members). */
    create: post("/homes/:homeId/threads"),
    /** POST /api/threads/:threadId/leave — leave a thread (stop notifications). */
    leave: post("/threads/:threadId/leave"),
    /** POST /api/threads/:threadId/title — rename a thread (creator or admin). */
    renameThread: post("/threads/:threadId/title"),
    /** POST /api/threads/:threadId/pickup — pick up posts into a thread. */
    pickup: post("/threads/:threadId/pickup"),
    /** GET /api/homes/:homeId/messages — main-channel messages (members). */
    mainMessages: get("/homes/:homeId/messages"),
    /** POST /api/homes/:homeId/messages — post to the main channel (members). */
    mainPost: post("/homes/:homeId/messages"),
    /** POST /api/homes/:homeId/reposts — repost into the main channel. */
    mainRepost: post("/homes/:homeId/reposts"),
    /** GET /api/homes/:homeId/stream — main-channel SSE pings (members). */
    mainStream: get("/homes/:homeId/stream"),
    /** GET /api/threads/:threadId/messages — messages in a thread (members). */
    messages: get("/threads/:threadId/messages"),
    /** POST /api/threads/:threadId/messages — post a message (members). */
    post: post("/threads/:threadId/messages"),
    /** POST /api/threads/:threadId/reposts — repost a message here (members). */
    repost: post("/threads/:threadId/reposts"),
    /** POST /api/messages/:messageId/reactions — toggle a reaction (members). */
    react: post("/messages/:messageId/reactions"),
    /** GET /api/reactions/recent — the caller's recently-used emoji. */
    recentEmojis: get("/reactions/recent"),
    /** GET /api/threads/:threadId/stream — SSE change pings (members). */
    stream: get("/threads/:threadId/stream"),
    /** POST /api/messages/:messageId — edit a message (author). */
    editMessage: post("/messages/:messageId"),
    /** DELETE /api/messages/:messageId — delete a message (author or admin). */
    deleteMessage: del("/messages/:messageId"),
  }),
});
