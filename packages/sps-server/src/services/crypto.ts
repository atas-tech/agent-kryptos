import { createHmac, randomBytes } from "node:crypto";
import type { RequestScope } from "../types.js";

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
