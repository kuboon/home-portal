/**
 * MCP endpoints for agents (JSON-RPC over HTTP). Two credential types, one
 * acting identity: whatever the caller presents, tool calls run as an agent
 * user with the same membership checks and rate limits as a human.
 *
 * `POST /mcp/:agentId` — the canonical endpoint. Either
 *   - an OAuth access token from id.kbn.one whose `aud` is this exact URL
 *     (RFC 8707). Its `sub` is the human who approved the flow, and they must
 *     own `:agentId`; or
 *   - that agent's own `hpa_` token, for unattended bots that have no browser
 *     to run an authorization flow.
 *
 * `POST /mcp` — legacy. `hpa_` only, acting as the token's own agent.
 *
 * A 401 from `/mcp/:agentId` carries `WWW-Authenticate` pointing at the
 * resource metadata (RFC 9728), which is how an MCP client discovers the
 * authorization server.
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { getAgentIdByToken, getAgentOwner } from "@scope/db";
import { handleRpc, type JsonRpcRequest } from "../mcp/server.ts";
import { AccessTokenError, challenge, verifyAccessToken } from "../oauth_rs.ts";
import type { routes } from "../routes.ts";

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/** 401 for a credential that was presented and rejected. */
const invalidToken = (message: string, agentId: string): Response =>
  Response.json({ error: message }, {
    status: 401,
    headers: { "WWW-Authenticate": challenge(agentId, message) },
  });

/** 401 for a request with no credential — a bare challenge starts discovery. */
const authRequired = (agentId: string): Response =>
  Response.json({ error: "authorization required" }, {
    status: 401,
    headers: { "WWW-Authenticate": challenge(agentId) },
  });

/** Read + dispatch the JSON-RPC body as `agentId`. */
async function dispatch(request: Request, agentId: string): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 },
    );
  }
  const response = await handleRpc(body, agentId);
  if (response === null) return new Response(null, { status: 202 });
  return Response.json(response);
}

export const mcpAgentAction = {
  async handler(context) {
    const { agentId } = context.params;
    const token = bearer(context.request);
    if (!token) return authRequired(agentId);

    if (token.startsWith("hpa_")) {
      // Unattended bot: the token must belong to the agent in the URL, so a
      // token can't be pointed at someone else's bot.
      const tokenAgentId = await getAgentIdByToken(token);
      if (!tokenAgentId) return invalidToken("invalid agent token", agentId);
      if (tokenAgentId !== agentId) {
        return invalidToken("token does not match this agent", agentId);
      }
      return await dispatch(context.request, agentId);
    }

    // OAuth: the token proves a human approved a client for THIS endpoint;
    // ownership is what lets them speak as this bot.
    let sub: string;
    try {
      sub = await verifyAccessToken(token, agentId);
    } catch (error) {
      if (error instanceof AccessTokenError) {
        return invalidToken(error.message, agentId);
      }
      throw error;
    }
    const owner = await getAgentOwner(agentId);
    if (!owner) return invalidToken("unknown agent", agentId);
    if (owner !== sub) {
      return Response.json({ error: "you do not own this agent" }, {
        status: 403,
      });
    }
    return await dispatch(context.request, agentId);
  },
} satisfies BuildAction<"POST", typeof routes.mcpAgent>;

export const mcpAction = {
  async handler(context) {
    const token = bearer(context.request);
    const agentId = token ? await getAgentIdByToken(token) : null;
    if (!agentId) {
      return Response.json({ error: "invalid agent token" }, { status: 401 });
    }
    return await dispatch(context.request, agentId);
  },
} satisfies BuildAction<"POST", typeof routes.mcp>;
