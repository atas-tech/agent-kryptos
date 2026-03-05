export type RequestStatus = "pending" | "submitted";

export type RequestScope = "metadata" | "submit";

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

export interface RequestStore {
  setRequest(data: StoredRequest, ttlSeconds: number): Promise<void>;
  getRequest(requestId: string): Promise<StoredRequest | null>;
  updateRequest(requestId: string, patch: Partial<StoredRequest>, ttlSeconds?: number): Promise<StoredRequest | null>;
  atomicRetrieveAndDelete(requestId: string): Promise<StoredRequest | null>;
  deleteRequest(requestId: string): Promise<boolean>;
}
