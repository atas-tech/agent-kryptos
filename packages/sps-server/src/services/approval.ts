import { createHash } from "node:crypto";
import type { PolicyDecision, StoredApprovalRequest } from "../types.js";

export interface ApprovalTuple {
  requesterId: string;
  workspaceId?: string;
  secretName: string;
  purpose: string;
  fulfillerHint: string;
  ruleId: string;
}

export interface CreateApprovalRequestParams extends ApprovalTuple {
  approvalReference: string;
  workspaceId?: string;
  reason: string;
  requesterRing?: string | null;
  fulfillerRing?: string | null;
  approverIds?: string[];
  approverRings?: string[];
  createdAt: number;
  expiresAt: number;
}

function normalizeList(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function ringFromAgentId(agentId: string): string | null {
  const match = agentId.match(/\/ring\/([^/]+)/);
  return match?.[1] ?? null;
}

export function buildApprovalReference(input: ApprovalTuple): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        requesterId: input.requesterId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        secretName: input.secretName,
        purpose: input.purpose,
        fulfillerHint: input.fulfillerHint,
        ruleId: input.ruleId
      })
    )
    .digest("hex");

  return `apr_${digest.slice(0, 24)}`;
}

export function createApprovalRequest(params: CreateApprovalRequestParams): StoredApprovalRequest {
  return {
    approvalReference: params.approvalReference,
    requesterId: params.requesterId,
    workspaceId: params.workspaceId,
    secretName: params.secretName,
    purpose: params.purpose,
    fulfillerHint: params.fulfillerHint,
    ruleId: params.ruleId,
    reason: params.reason,
    requesterRing: params.requesterRing ?? null,
    fulfillerRing: params.fulfillerRing ?? null,
    approverIds: normalizeList(params.approverIds),
    approverRings: normalizeList(params.approverRings),
    status: "pending",
    createdAt: params.createdAt,
    expiresAt: params.expiresAt
  };
}

export function approvalMatches(record: StoredApprovalRequest, tuple: ApprovalTuple): boolean {
  return (
    record.requesterId === tuple.requesterId &&
    (record.workspaceId ?? null) === (tuple.workspaceId ?? null) &&
    record.secretName === tuple.secretName &&
    record.purpose === tuple.purpose &&
    record.fulfillerHint === tuple.fulfillerHint &&
    record.ruleId === tuple.ruleId
  );
}

export function isApproverAuthorized(record: StoredApprovalRequest, approverId: string): boolean {
  if (record.approverIds && !record.approverIds.includes(approverId)) {
    return false;
  }

  const approverRing = ringFromAgentId(approverId);
  if (record.approverRings && (!approverRing || !record.approverRings.includes(approverRing))) {
    return false;
  }

  return true;
}

export function promoteApprovedDecision(
  decision: PolicyDecision,
  approvalReference: string,
  decidedBy: string | undefined
): PolicyDecision {
  return {
    ...decision,
    mode: "allow",
    approvalRequired: false,
    approvalReference,
    reason: decidedBy ? `exchange approved by ${decidedBy}` : "exchange approved"
  };
}
