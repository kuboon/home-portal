/**
 * Server-to-server push: send notifications to users via the IdP's
 * `POST /rp/notifications`, authenticated with a `private_key_jwt` client
 * assertion (RFC 7521/7523) signed by our RP key (see `rp_key.ts`).
 */

import { SignJWT } from "jose";
import { getRpKey } from "./rp_key.ts";

const RP_ORIGIN = Deno.env.get("RP_ORIGIN") ?? "https://home.kbn.one";
const IDP_ORIGIN = Deno.env.get("IDP_ORIGIN") ?? "https://id.kbn.one";

const CLIENT_ASSERTION_TYP = "client-assertion+jwt";

export interface NotificationContent {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
}

/** Mint a short-lived, single-use client assertion for the IdP. */
async function clientAssertion(): Promise<string> {
  const { privateKey, kid } = await getRpKey();
  return await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: CLIENT_ASSERTION_TYP, kid })
    .setIssuer(RP_ORIGIN) // clientId = our origin (must be IdP-whitelisted)
    .setSubject(RP_ORIGIN)
    .setAudience(IDP_ORIGIN)
    .setIssuedAt()
    .setExpirationTime("60s")
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

/**
 * Deliver `notification` to every device of the given users. Best-effort:
 * resolves to the IdP `results` array, or `[]` on transport failure (logged).
 */
export async function sendToUsers(
  userIds: string[],
  notification: NotificationContent,
): Promise<unknown[]> {
  if (userIds.length === 0) return [];
  try {
    const assertion = await clientAssertion();
    const response = await fetch(`${IDP_ORIGIN}/rp/notifications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${assertion}`,
      },
      body: JSON.stringify({ userIds, notification }),
    });
    if (!response.ok) {
      console.warn(`[push] /rp/notifications ${response.status}`);
      return [];
    }
    const data = await response.json() as { results?: unknown[] };
    return data.results ?? [];
  } catch (error) {
    console.warn("[push] send failed", error);
    return [];
  }
}

export { RP_ORIGIN };
