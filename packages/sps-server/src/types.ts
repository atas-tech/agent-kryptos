export type RequestStatus = "pending" | "submitted";

export type RequestScope = "metadata" | "submit";

export type ExchangeStatus = "pending" | "reserved" | "submitted" | "retrieved" | "revoked" | "expired" | "denied";

export type PolicyDecisionMode = "allow" | "pending_approval" | "deny";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type LifecycleEventType =
  | "exchange_requested"
  | "exchange_reserved"
  | "exchange_submitted"
  | "exchange_retrieved"
  | "approval_requested"
  | "approval_decided"
  | "exchange_revoked";

export interface StoredRequest {
  requestId: string;
  requesterId?: string;
  workspaceId?: string;
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
  workspaceId?: string;
  requesterPublicKey: string;
  secretName: string;
  purpose: string;
  fulfillerHint: string;
  allowedFulfillerId: string;
  priorExchangeId?: string | null;
  supersedesExchangeId?: string | null;
  fulfilledBy?: string;
  policyDecision: PolicyDecision;
  policyHash: string;
  status: ExchangeStatus;
  createdAt: number;
  expiresAt: number;
  enc?: string;
  ciphertext?: string;
}

export interface StoredApprovalRequest {
  approvalReference: string;
  requesterId: string;
  workspaceId?: string;
  secretName: string;
  purpose: string;
  fulfillerHint: string;
  ruleId: string;
  reason: string;
  requesterRing?: string | null;
  fulfillerRing?: string | null;
  approverIds?: string[];
  approverRings?: string[];
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface ExchangeLifecycleRecord {
  recordId: string;
  eventType: LifecycleEventType;
  exchangeId?: string | null;
  approvalReference?: string | null;
  requesterId: string;
  workspaceId?: string;
  secretName: string;
  purpose: string;
  fulfillerHint?: string | null;
  actorId?: string | null;
  status?: string | null;
  priorStatus?: string | null;
  reason?: string | null;
  policyRuleId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export interface RequestStore {
  setRequest(data: StoredRequest, ttlSeconds: number): Promise<void>;
  getRequest(requestId: string): Promise<StoredRequest | null>;
  updateRequest(requestId: string, patch: Partial<StoredRequest>, ttlSeconds?: number): Promise<StoredRequest | null>;
  atomicRetrieveAndDelete(requestId: string, requesterId?: string, workspaceId?: string): Promise<StoredRequest | null>;
  deleteRequest(requestId: string, requesterId?: string, workspaceId?: string): Promise<boolean>;
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
  atomicRetrieveExchange(exchangeId: string, requesterId: string, workspaceId?: string): Promise<StoredExchange | null>;
  setApprovalRequest(data: StoredApprovalRequest, ttlSeconds: number): Promise<void>;
  getApprovalRequest(approvalReference: string): Promise<StoredApprovalRequest | null>;
  updateApprovalRequest(
    approvalReference: string,
    patch: Partial<StoredApprovalRequest>,
    ttlSeconds?: number
  ): Promise<StoredApprovalRequest | null>;
  appendLifecycleRecord(record: ExchangeLifecycleRecord): Promise<void>;
  listLifecycleRecordsByExchange(exchangeId: string): Promise<ExchangeLifecycleRecord[]>;
  listLifecycleRecordsByApproval(approvalReference: string): Promise<ExchangeLifecycleRecord[]>;
}
