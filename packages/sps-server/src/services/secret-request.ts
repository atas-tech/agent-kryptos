import { generateConfirmationCode, generateRequestId, generateScopedSigs } from "./crypto.js";
import type { RequestStore, StoredRequest } from "../types.js";

export interface CreateSecretRequestInput {
  publicKey: string;
  description: string;
  requesterId?: string;
  workspaceId?: string;
  requestTtlSeconds: number;
  hmacSecret: string;
  uiBaseUrl: string;
  requireUserAuth?: boolean;
  requiredUserWorkspaceId?: string;
  requestedByActorType?: "user" | "agent" | "guest_agent" | "guest_human";
  guestIntentId?: string;
}

export interface CreatedSecretRequest {
  record: StoredRequest;
  secretUrl: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function createSecretRequest(
  store: RequestStore,
  input: CreateSecretRequestInput
): Promise<CreatedSecretRequest> {
  const requestId = generateRequestId();
  const confirmationCode = generateConfirmationCode();
  const createdAt = nowSeconds();
  const expiresAt = createdAt + input.requestTtlSeconds;

  const record: StoredRequest = {
    requestId,
    requesterId: input.requesterId,
    workspaceId: input.workspaceId,
    publicKey: input.publicKey,
    description: input.description,
    confirmationCode,
    status: "pending",
    createdAt,
    expiresAt,
    requireUserAuth: input.requireUserAuth === true,
    requiredUserWorkspaceId: input.requiredUserWorkspaceId,
    requestedByActorType: input.requestedByActorType,
    guestIntentId: input.guestIntentId
  };

  await store.setRequest(record, input.requestTtlSeconds);

  const sigs = generateScopedSigs(requestId, expiresAt, input.hmacSecret);
  const secretUrl = `${input.uiBaseUrl}/?id=${requestId}&metadata_sig=${encodeURIComponent(sigs.metadataSig)}&submit_sig=${encodeURIComponent(sigs.submitSig)}`;

  return {
    record,
    secretUrl
  };
}
