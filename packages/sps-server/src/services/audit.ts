export interface AuditEvent {
  event:
    | "request_created"
    | "secret_submitted"
    | "secret_retrieved"
    | "request_expired"
    | "request_revoked"
    | "exchange_requested"
    | "exchange_reserved"
    | "exchange_submitted"
    | "exchange_retrieved"
    | "exchange_revoked"
    | "exchange_approval_requested"
    | "exchange_approved"
    | "exchange_rejected"
    | "exchange_pending_approval"
    | "exchange_denied";
  requestId?: string;
  exchangeId?: string;
  agentId?: string;
  requesterId?: string;
  fulfilledBy?: string;
  secretName?: string;
  policyRuleId?: string;
  approvalReference?: string | null;
  workspaceId?: string | null;
  action: string;
  ip?: string;
}

export function logAudit(event: AuditEvent): void {
  const record = {
    timestamp: new Date().toISOString(),
    event: event.event,
    request_id: event.requestId ?? null,
    exchange_id: event.exchangeId ?? null,
    agent_id: event.agentId ?? null,
    requester_id: event.requesterId ?? null,
    fulfilled_by: event.fulfilledBy ?? null,
    workspace_id: event.workspaceId ?? null,
    secret_name: event.secretName ?? null,
    policy_rule_id: event.policyRuleId ?? null,
    approval_reference: event.approvalReference ?? null,
    action: event.action,
    ip: event.ip ?? null
  };

  // Keep logger simple for MVP; callers must avoid passing secret values.
  console.info(JSON.stringify(record));
}
