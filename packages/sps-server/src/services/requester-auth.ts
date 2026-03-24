import { jwtVerify, SignJWT } from "jose";
import type { GuestActorType } from "./guest-intent.js";
import { deriveGuestAccessTokenSecret } from "../utils/signing-secrets.js";

export interface GuestAccessTokenClaims {
  intent_id: string;
  request_id: string;
  requester_id: string;
  workspace_id: string;
  actor_type: GuestActorType;
}

function guestAccessSecret(rootSecret: string): Uint8Array {
  return new TextEncoder().encode(deriveGuestAccessTokenSecret(rootSecret));
}

export async function signGuestAccessToken(
  claims: GuestAccessTokenClaims,
  secret: string,
  expiresAt: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    intent_id: claims.intent_id,
    request_id: claims.request_id,
    requester_id: claims.requester_id,
    workspace_id: claims.workspace_id,
    actor_type: claims.actor_type
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("sps")
    .setAudience("guest-request")
    .setSubject(claims.request_id)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(guestAccessSecret(secret));
}

export async function verifyGuestAccessToken(token: string, secret: string): Promise<GuestAccessTokenClaims> {
  const { payload } = await jwtVerify(token, guestAccessSecret(secret), {
    issuer: "sps",
    audience: "guest-request"
  });

  const intentId = typeof payload.intent_id === "string" ? payload.intent_id : null;
  const requestId = typeof payload.request_id === "string" ? payload.request_id : null;
  const requesterId = typeof payload.requester_id === "string" ? payload.requester_id : null;
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : null;
  const actorType = payload.actor_type === "guest_agent" || payload.actor_type === "guest_human"
    ? payload.actor_type
    : null;

  if (!intentId || !requestId || !requesterId || !workspaceId || !actorType) {
    throw new Error("Invalid guest access token payload");
  }

  return {
    intent_id: intentId,
    request_id: requestId,
    requester_id: requesterId,
    workspace_id: workspaceId,
    actor_type: actorType
  };
}
