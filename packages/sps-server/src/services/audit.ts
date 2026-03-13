import type { Pool } from "pg";
import { decodePageCursor, encodePageCursor } from "./pagination.js";

export type AuditActorType = "user" | "agent" | "system";

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
    | "exchange_denied"
    | "agent_enrolled"
    | "agent_api_key_rotated"
    | "agent_revoked"
    | "member_created"
    | "member_updated";
  requestId?: string;
  exchangeId?: string;
  approvalReference?: string | null;
  agentId?: string;
  requesterId?: string;
  fulfilledBy?: string;
  secretName?: string;
  policyRuleId?: string;
  workspaceId?: string | null;
  action: string;
  ip?: string;
  actorId?: string | null;
  actorType?: AuditActorType | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditRecord {
  id: string;
  workspaceId: string | null;
  eventType: string;
  actorId: string | null;
  actorType: AuditActorType | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
}

export interface ListAuditRecordsInput {
  eventType?: string;
  actorType?: AuditActorType;
  resourceId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface AuditRecordPage {
  records: AuditRecord[];
  nextCursor: string | null;
}

interface AuditRow {
  id: string;
  workspace_id: string | null;
  event_type: string;
  actor_id: string | null;
  actor_type: AuditActorType | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
}

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;
const DEFAULT_RETENTION_DAYS = 30;

function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries);
}

function toAuditRow(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    actorType: row.actor_type,
    resourceId: row.resource_id,
    metadata: row.metadata,
    ipAddress: row.ip_address,
    createdAt: row.created_at
  };
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_AUDIT_LIMIT;
  }

  return Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_AUDIT_LIMIT)));
}

function buildMetadata(event: AuditEvent): Record<string, unknown> | null {
  return sanitizeMetadata({
    action: event.action,
    request_id: event.requestId,
    exchange_id: event.exchangeId,
    requester_id: event.requesterId,
    fulfilled_by: event.fulfilledBy,
    secret_name: event.secretName,
    policy_rule_id: event.policyRuleId,
    approval_reference: event.approvalReference ?? undefined,
    ...event.metadata
  });
}

function actorIdForEvent(event: AuditEvent): string | null {
  return event.actorId ?? event.agentId ?? null;
}

function actorTypeForEvent(event: AuditEvent): AuditActorType | null {
  if (event.actorType) {
    return event.actorType;
  }

  return event.agentId ? "agent" : null;
}

function resourceIdForEvent(event: AuditEvent): string | null {
  return event.resourceId ?? event.exchangeId ?? event.requestId ?? event.approvalReference ?? null;
}

export async function logAudit(db: Pool | null | undefined, event: AuditEvent): Promise<void> {
  const metadata = buildMetadata(event);
  const record = {
    timestamp: new Date().toISOString(),
    event: event.event,
    request_id: event.requestId ?? null,
    exchange_id: event.exchangeId ?? null,
    actor_id: actorIdForEvent(event),
    actor_type: actorTypeForEvent(event),
    requester_id: event.requesterId ?? null,
    fulfilled_by: event.fulfilledBy ?? null,
    workspace_id: event.workspaceId ?? null,
    resource_id: resourceIdForEvent(event),
    secret_name: event.secretName ?? null,
    policy_rule_id: event.policyRuleId ?? null,
    approval_reference: event.approvalReference ?? null,
    action: event.action,
    metadata,
    ip: event.ip ?? null
  };

  console.info(JSON.stringify(record));

  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO audit_log (
        workspace_id,
        event_type,
        actor_id,
        actor_type,
        resource_id,
        metadata,
        ip_address
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
    [
      event.workspaceId ?? null,
      event.event,
      actorIdForEvent(event),
      actorTypeForEvent(event),
      resourceIdForEvent(event),
      metadata ? JSON.stringify(metadata) : null,
      event.ip ?? null
    ]
  );
}

export async function listAuditRecords(
  db: Pool,
  workspaceId: string,
  input: ListAuditRecordsInput = {}
): Promise<AuditRecordPage> {
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;

  if (input.cursor) {
    const decoded = decodePageCursor(input.cursor);
    cursorCreatedAt = decoded.createdAt;
    cursorId = decoded.id;
  }

  const limit = normalizeLimit(input.limit);
  const values: Array<string | number | Date> = [workspaceId];
  const clauses = ["workspace_id = $1"];

  if (input.eventType) {
    values.push(input.eventType);
    clauses.push(`event_type = $${values.length}`);
  }

  if (input.actorType) {
    values.push(input.actorType);
    clauses.push(`actor_type = $${values.length}`);
  }

  if (input.resourceId) {
    values.push(input.resourceId);
    clauses.push(`resource_id = $${values.length}`);
  }

  if (input.from) {
    values.push(input.from);
    clauses.push(`created_at >= $${values.length}`);
  }

  if (input.to) {
    values.push(input.to);
    clauses.push(`created_at <= $${values.length}`);
  }

  if (cursorCreatedAt && cursorId) {
    values.push(cursorCreatedAt, cursorId);
    clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
  }

  values.push(limit + 1);

  const result = await db.query<AuditRow>(
    `
      SELECT
        id,
        workspace_id,
        event_type,
        actor_id,
        actor_type,
        resource_id,
        metadata,
        ip_address,
        created_at
      FROM audit_log
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `,
    values
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const lastRow = rows.at(-1);

  return {
    records: rows.map(toAuditRow),
    nextCursor: hasMore && lastRow
      ? encodePageCursor({
          createdAt: lastRow.created_at,
          id: lastRow.id
        })
      : null
  };
}

export async function listExchangeAuditRecords(
  db: Pool,
  workspaceId: string,
  exchangeId: string
): Promise<AuditRecord[]> {
  const exchangeRecords = await db.query<AuditRow>(
    `
      SELECT
        id,
        workspace_id,
        event_type,
        actor_id,
        actor_type,
        resource_id,
        metadata,
        ip_address,
        created_at
      FROM audit_log
      WHERE workspace_id = $1
        AND resource_id = $2
      ORDER BY created_at ASC, id ASC
    `,
    [workspaceId, exchangeId]
  );

  const approvalReferences = new Set<string>();
  for (const row of exchangeRecords.rows) {
    const approvalReference = row.metadata?.approval_reference;
    if (typeof approvalReference === "string" && approvalReference.trim()) {
      approvalReferences.add(approvalReference);
    }
  }

  if (approvalReferences.size === 0) {
    return exchangeRecords.rows.map(toAuditRow);
  }

  const approvalRecords = await db.query<AuditRow>(
    `
      SELECT
        id,
        workspace_id,
        event_type,
        actor_id,
        actor_type,
        resource_id,
        metadata,
        ip_address,
        created_at
      FROM audit_log
      WHERE workspace_id = $1
        AND resource_id = ANY($2::text[])
      ORDER BY created_at ASC, id ASC
    `,
    [workspaceId, Array.from(approvalReferences)]
  );

  const merged = new Map<string, AuditRecord>();
  for (const row of [...approvalRecords.rows, ...exchangeRecords.rows]) {
    merged.set(row.id, toAuditRow(row));
  }

  return Array.from(merged.values()).sort((left, right) => {
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }

    return left.id.localeCompare(right.id);
  });
}

export async function cleanupExpiredAuditRecords(
  db: Pool,
  options: { retentionDays?: number; now?: Date } = {}
): Promise<number> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await db.query(
    `
      DELETE FROM audit_log
      WHERE created_at < $1
    `,
    [cutoff]
  );

  return result.rowCount ?? 0;
}
