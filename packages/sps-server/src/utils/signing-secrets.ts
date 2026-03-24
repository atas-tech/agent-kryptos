import { createHmac } from "node:crypto";

type SigningDomain =
  | "browser-sig"
  | "agent-fulfillment"
  | "guest-fulfillment"
  | "guest-access";

function deriveSigningSecret(rootSecret: string, domain: SigningDomain): string {
  return createHmac("sha256", rootSecret).update(`blindpass:${domain}`).digest("base64url");
}

export function deriveBrowserSigSecret(rootSecret: string): string {
  return deriveSigningSecret(rootSecret, "browser-sig");
}

export function deriveAgentFulfillmentTokenSecret(rootSecret: string): string {
  return deriveSigningSecret(rootSecret, "agent-fulfillment");
}

export function deriveGuestFulfillmentTokenSecret(rootSecret: string): string {
  return deriveSigningSecret(rootSecret, "guest-fulfillment");
}

export function deriveGuestAccessTokenSecret(rootSecret: string): string {
  return deriveSigningSecret(rootSecret, "guest-access");
}
