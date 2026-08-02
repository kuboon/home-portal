/**
 * GET /.well-known/oauth-protected-resource/mcp/:agentId — OAuth 2.0 Protected
 * Resource Metadata (RFC 9728).
 *
 * This is how an MCP client finds the authorization server for a bot endpoint:
 * it either derives this URL from the resource (`/mcp/:agentId` with the
 * well-known prefix spliced in after the host) or follows the
 * `resource_metadata` link in our 401 `WWW-Authenticate` header.
 *
 * The document is static per agent and reveals nothing secret — it only names
 * the AS — so it is served without auth and without checking that the agent
 * exists (a probe for a bogus id learns nothing it couldn't guess).
 */

import type { BuildAction } from "@remix-run/fetch-router";
import { IDP_ORIGIN, mcpResourceUri } from "../oauth_rs.ts";
import type { routes } from "../routes.ts";

export const mcpResourceMetadataAction = {
  handler(context) {
    const { agentId } = context.params;
    return Response.json({
      resource: mcpResourceUri(agentId),
      authorization_servers: [IDP_ORIGIN],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    }, {
      headers: {
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      },
    });
  },
} satisfies BuildAction<"GET", typeof routes.mcpResourceMetadata>;
