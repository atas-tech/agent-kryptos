export type RequestStatus = "pending" | "submitted";

export type RequestScope = "metadata" | "submit";

export type ExchangeStatus = "pending" | "reserved" | "submitted" | "retrieved" | "revoked" | "expired" | "denied";

export type PolicyDecisionMode = "allow" | "pending_approval" | "deny";

export interface StoredRequest {
  requestId: string;
  publicKey: string;
  description: string;
  confirmationCode: string;
  status: RequestStatus;
  createdAt: number;
  expiresAt: number;
  enc?: string;
  ciphertext?: string;
}

export interface PolicyDecision {
  mode: PolicyDecisionMode;
  approvalRequired: boolean;
  ruleId: string;
  reason: string;
  approvalReference?: string | null;
  requesterRing?: string | null;
  fulfillerRing?: string | null;
  secretName: string;
}

export interface StoredExchange {
  exchangeId: string;
  requesterId: string;
  requesterPublicKey: string;
  secretName: string;
  purpose: string;
  fulfillerHint: string;
  allowedFulfillerId: string;
  fulfilledBy?: string;
  policyDecision: PolicyDecision;
  policyHash: string;
  status: ExchangeStatus;
  createdAt: number;
  expiresAt: number;
  enc?: string;
  ciphertext?: string;
}

export interface RequestStore {
  setRequest(data: StoredRequest, ttlSeconds: number): Promise<void>;
  getRequest(requestId: string): Promise<StoredRequest | null>;
  updateRequest(requestId: string, patch: Partial<StoredRequest>, ttlSeconds?: number): Promise<StoredRequest | null>;
  atomicRetrieveAndDelete(requestId: string): Promise<StoredRequest | null>;
  deleteRequest(requestId: string): Promise<boolean>;
  setExchange(data: StoredExchange, ttlSeconds: number): Promise<void>;
  getExchange(exchangeId: string): Promise<StoredExchange | null>;
  revokeExchange(exchangeId: string, ttlSeconds: number): Promise<StoredExchange | null>;
  reserveExchange(exchangeId: string, fulfillerId: string): Promise<StoredExchange | null>;
  submitExchange(
    exchangeId: string,
    fulfillerId: string,
    enc: string,
    ciphertext: string,
    expiresAt: number,
    ttlSeconds: number
  ): Promise<StoredExchange | null>;
  atomicRetrieveExchange(exchangeId: string, requesterId: string): Promise<StoredExchange | null>;
}
