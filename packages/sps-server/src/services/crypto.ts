import { createHmac, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { PolicyDecision, RequestScope } from "../types.js";

const ADJECTIVES = [
  "BLUE",
  "GREEN",
  "SILVER",
  "BRIGHT",
  "BOLD",
  "SWIFT",
  "CALM",
  "NOBLE"
];

const NOUNS = [
  "FOX",
  "RIVER",
  "MOUNTAIN",
  "FALCON",
  "HARBOR",
  "PINE",
  "MEADOW",
  "FIELD"
];

interface CanonicalPayload {
  requestId: string;
  exp: number;
  scope: RequestScope;
}

export interface FulfillmentTokenClaims {
  exchange_id: string;
  requester_id: string;
  workspace_id?: string;
  secret_name: string;
  purpose: string;
  policy_hash: string;
  approval_reference?: string | null;
}

function canonicalize(payload: CanonicalPayload): string {
  return `${payload.requestId}.${payload.exp}.${payload.scope}`;
}

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function generateRequestId(): string {
  return randomBytes(32).toString("hex");
}

export function generateConfirmationCode(): string {
  const adjective = ADJECTIVES[randomBytes(1)[0] % ADJECTIVES.length];
  const noun = NOUNS[randomBytes(1)[0] % NOUNS.length];
  const number = randomBytes(1)[0] % 100;
  return `${adjective}-${noun}-${number.toString().padStart(2, "0")}`;
}

export function signPayload(payload: CanonicalPayload, secret: string): string {
  const signature = hmac(canonicalize(payload), secret);
  return `${payload.exp}.${signature}`;
}

export function verifyPayload(
  requestId: string,
  scope: RequestScope,
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): { ok: true; exp: number } | { ok: false; reason: "invalid" | "expired" } {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "invalid" };
  }

  const [expRaw, signature] = parts;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= 0 || !signature) {
    return { ok: false, reason: "invalid" };
  }

  if (exp < nowSeconds) {
    return { ok: false, reason: "expired" };
  }

  const expected = hmac(canonicalize({ requestId, exp, scope }), secret);
  if (expected !== signature) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, exp };
}

export function generateScopedSigs(requestId: string, exp: number, secret: string): { metadataSig: string; submitSig: string } {
  return {
    metadataSig: signPayload({ requestId, exp, scope: "metadata" }, secret),
    submitSig: signPayload({ requestId, exp, scope: "submit" }, secret)
  };
}

function fulfillmentSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signFulfillmentToken(
  claims: FulfillmentTokenClaims,
  secret: string,
  expiresAt: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    exchange_id: claims.exchange_id,
    requester_id: claims.requester_id,
    workspace_id: claims.workspace_id ?? null,
    secret_name: claims.secret_name,
    purpose: claims.purpose,
    policy_hash: claims.policy_hash,
    approval_reference: claims.approval_reference ?? null
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.workspace_id ?? claims.requester_id)
    .setIssuer("sps")
    .setAudience("agent-fulfill")
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(fulfillmentSecret(secret));
}

export async function verifyFulfillmentToken(token: string, secret: string): Promise<FulfillmentTokenClaims> {
  const { payload } = await jwtVerify(token, fulfillmentSecret(secret), {
    issuer: "sps",
    audience: "agent-fulfill"
  });

  const exchangeId = typeof payload.exchange_id === "string" ? payload.exchange_id : null;
  const requesterId = typeof payload.requester_id === "string" ? payload.requester_id : null;
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : undefined;
  const secretName = typeof payload.secret_name === "string" ? payload.secret_name : null;
  const purpose = typeof payload.purpose === "string" ? payload.purpose : null;
  const policyHash = typeof payload.policy_hash === "string" ? payload.policy_hash : null;
  const approvalReference =
    typeof payload.approval_reference === "string" ? payload.approval_reference : payload.approval_reference === null ? null : undefined;

  if (!exchangeId || !requesterId || !secretName || !purpose || !policyHash) {
    throw new Error("Invalid fulfillment token payload");
  }

  return {
    exchange_id: exchangeId,
    requester_id: requesterId,
    workspace_id: workspaceId,
    secret_name: secretName,
    purpose,
    policy_hash: policyHash,
    approval_reference: approvalReference
  };
}
