export interface AuditEvent {
  event: "request_created" | "secret_submitted" | "secret_retrieved" | "request_expired" | "request_revoked";
  requestId: string;
  agentId?: string;
  action: string;
  ip?: string;
}

export function logAudit(event: AuditEvent): void {
  const record = {
    timestamp: new Date().toISOString(),
    event: event.event,
    request_id: event.requestId,
    agent_id: event.agentId ?? null,
    action: event.action,
    ip: event.ip ?? null
  };

  // Keep logger simple for MVP; callers must avoid passing secret values.
  console.info(JSON.stringify(record));
}
