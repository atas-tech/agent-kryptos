import { Check, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import { EmptyState } from "../components/EmptyState.js";
import { ResourceLabel } from "../components/ResourceLabel.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface AuditRecord {
  id: string;
  event_type: string;
  actor_id: string | null;
  actor_type: "user" | "agent" | "system" | "guest_agent" | "guest_human" | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AuditListResponse {
  records: AuditRecord[];
  next_cursor: string | null;
}

interface GuestIntentRecord {
  id: string;
  actor_type: "guest_agent" | "guest_human";
  approval_status: "pending" | "approved" | "rejected" | null;
  approval_reference: string | null;
  requester_label: string | null;
  purpose: string;
  resolved_secret_name: string;
  allowed_fulfiller_id: string | null;
  created_at: string;
  expires_at: string;
}

interface GuestIntentListResponse {
  intents: GuestIntentRecord[];
}

interface ApprovalCard {
  id: string;
  kind: "exchange" | "guest";
  approvalReference: string | null;
  requesterLabel: string;
  fulfillerHint: string;
  secretName: string;
  purpose: string;
  ruleId: string;
  requestedAt: string;
  expiresAt: string;
  actorType: "agent" | "guest_agent" | "guest_human";
}

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatTimestamp(value: string): string {
  return dateFormatter.format(new Date(value));
}

function extractString(metadata: Record<string, unknown> | null, key: string, fallback = "n/a"): string {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function actorLabel(actorType: ApprovalCard["actorType"]): string {
  if (actorType === "guest_agent") {
    return "guest agent";
  }

  if (actorType === "guest_human") {
    return "guest human";
  }

  return "agent";
}

function buildExchangeApprovalCards(records: AuditRecord[]): ApprovalCard[] {
  const decidedReferences = new Set<string>();
  const pendingMap = new Map<string, ApprovalCard>();

  for (const record of records) {
    if (!record.resource_id?.startsWith("apr_")) {
      continue;
    }

    if (record.event_type === "exchange_approved" || record.event_type === "exchange_rejected") {
      decidedReferences.add(record.resource_id);
      pendingMap.delete(record.resource_id);
      continue;
    }

    if (record.event_type !== "exchange_approval_requested") {
      continue;
    }

    const requestedAtMs = new Date(record.created_at).getTime();
    if (Number.isNaN(requestedAtMs) || requestedAtMs + APPROVAL_TTL_MS <= Date.now()) {
      continue;
    }

    pendingMap.set(record.resource_id, {
      id: record.resource_id,
      kind: "exchange",
      approvalReference: record.resource_id,
      requesterLabel: extractString(record.metadata, "requester_id"),
      fulfillerHint: extractString(record.metadata, "fulfilled_by"),
      secretName: extractString(record.metadata, "secret_name"),
      purpose: extractString(record.metadata, "purpose"),
      ruleId: extractString(record.metadata, "policy_rule_id"),
      requestedAt: record.created_at,
      expiresAt: new Date(requestedAtMs + APPROVAL_TTL_MS).toISOString(),
      actorType: "agent"
    });
  }

  return Array.from(pendingMap.values()).filter((approval) => !decidedReferences.has(approval.id));
}

function buildGuestApprovalCards(intents: GuestIntentRecord[]): ApprovalCard[] {
  return intents
    .filter((intent) => intent.approval_status === "pending")
    .map((intent) => ({
      id: intent.id,
      kind: "guest",
      approvalReference: intent.approval_reference,
      requesterLabel: intent.requester_label?.trim() || intent.actor_type.replace("_", " "),
      fulfillerHint: intent.allowed_fulfiller_id ?? "workspace human",
      secretName: intent.resolved_secret_name,
      purpose: intent.purpose,
      ruleId: intent.approval_reference ?? "guest-intent",
      requestedAt: intent.created_at,
      expiresAt: intent.expires_at,
      actorType: intent.actor_type
    }));
}

export function ApprovalsPage() {
  const { user } = useAuth();
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<string | null>(null);

  const canDecide = user?.role === "workspace_admin" || user?.role === "workspace_operator";

  useEffect(() => {
    void loadApprovals();
  }, []);

  async function loadApprovals(): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const since = new Date(Date.now() - APPROVAL_TTL_MS).toISOString();
      const auditParams = new URLSearchParams({
        limit: "200",
        from: since
      });
      const guestParams = new URLSearchParams({
        limit: "200",
        status: "pending_approval",
        approval_status: "pending"
      });

      const [auditPayload, guestPayload] = await Promise.all([
        apiRequest<AuditListResponse>(`/api/v2/audit?${auditParams.toString()}`),
        apiRequest<GuestIntentListResponse>(`/api/v2/public/intents/admin?${guestParams.toString()}`)
      ]);

      const nextApprovals = [
        ...buildExchangeApprovalCards(auditPayload.records),
        ...buildGuestApprovalCards(guestPayload.intents)
      ].sort((left, right) => new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime());

      setApprovals(nextApprovals);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load approvals");
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleDecision(approval: ApprovalCard, decision: "approve" | "reject"): Promise<void> {
    setActionPendingId(approval.id);
    setActionError(null);
    setLastDecision(null);

    try {
      const path = approval.kind === "guest"
        ? `/api/v2/public/intents/${approval.id}/${decision}`
        : `/api/v2/secret/exchange/admin/approval/${approval.id}/${decision}`;

      await apiRequest<Record<string, unknown>>(path, { method: "POST" });

      setApprovals((current) => current.filter((entry) => entry.id !== approval.id));
      setLastDecision(`${decision === "approve" ? "Approved" : "Denied"} ${approval.id}.`);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "Unable to update approval");
    } finally {
      setActionPendingId(null);
    }
  }

  const expiringSoonCount = approvals.filter(
    (approval) => new Date(approval.expiresAt).getTime() - Date.now() <= 2 * 60 * 1000
  ).length;
  const distinctRules = new Set(approvals.map((approval) => approval.ruleId)).size;
  const guestCount = approvals.filter((approval) => approval.kind === "guest").length;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">Milestone 4</div>
            <h2 className="hero-card__title">Approvals inbox</h2>
            <p className="hero-card__body">
              Pending exchange approvals and guest intent approvals share one queue. Admins and operators can decide
              both here, while viewers stay read-only.
            </p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => void loadApprovals()} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Pending approvals</span>
            <strong>{approvals.length}</strong>
          </article>
          <article className="metric-panel">
            <span>Guest requests</span>
            <strong>{guestCount}</strong>
          </article>
          <article className="metric-panel">
            <span>Rules in play</span>
            <strong>{distinctRules}</strong>
          </article>
          <article className="metric-panel">
            <span>Expiring soon</span>
            <strong>{expiringSoonCount}</strong>
          </article>
        </div>
      </div>

      {!canDecide ? (
        <div className="panel-card approvals-viewer-note">
          <ShieldAlert size={18} />
          <div>
            <div className="record-title">Viewer access is read-only</div>
            <div className="panel-card__body">
              You can inspect pending approvals here, but only workspace admins and operators can approve or deny them.
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}
      {actionError ? <div className="error-banner">{actionError}</div> : null}
      {lastDecision ? <div className="status-pill approvals-status">{lastDecision}</div> : null}

      {loading ? (
        <div className="panel-card">
          <div className="empty-state">
            <div className="empty-state__eyebrow">Loading</div>
            <h3>Refreshing approvals</h3>
            <p>Collecting pending exchange and guest approvals from the active workspace.</p>
          </div>
        </div>
      ) : approvals.length === 0 ? (
        <EmptyState
          body="No currently pending exchange or guest approvals were found in the active workspace window."
          title="Inbox clear"
        />
      ) : (
        <div className="approval-grid">
          {approvals.map((approval) => {
            const actionPending = actionPendingId === approval.id;
            const expiringSoon = new Date(approval.expiresAt).getTime() - Date.now() <= 2 * 60 * 1000;
            const sourceLabel = approval.kind === "guest" ? "Pending guest approval" : "Pending agent approval";
            const requesterLabel = approval.kind === "guest" ? "Guest requester" : "Requester agent";
            const fulfillerLabel = approval.kind === "guest" ? "Delivery target" : "Fulfiller agent";

            return (
              <article key={approval.id} className="approval-card">
                <div className="approval-card__header">
                  <div>
                    <div className="section-label">{sourceLabel}</div>
                    <h3 className="approval-card__title">{approval.secretName}</h3>
                  </div>
                  <StatusBadge tone={expiringSoon ? "warning" : "neutral"}>
                    {expiringSoon ? "expiring" : actorLabel(approval.actorType)}
                  </StatusBadge>
                </div>

                <div className="detail-list">
                  <div className="detail-list__item">
                    <span className="meta-label">{requesterLabel}</span>
                    <ResourceLabel value={approval.requesterLabel} />
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">{fulfillerLabel}</span>
                    <ResourceLabel value={approval.fulfillerHint} />
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">Requested at</span>
                    <strong>{formatTimestamp(approval.requestedAt)}</strong>
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">{approval.kind === "guest" ? "Approval ref" : "Rule"}</span>
                    <strong>{approval.kind === "guest" ? approval.approvalReference ?? "n/a" : approval.ruleId}</strong>
                  </div>
                </div>

                <div className="approval-card__purpose">
                  <span className="meta-label">Purpose</span>
                  <p>{approval.purpose}</p>
                </div>

                <div className="approval-card__footer">
                  <ResourceLabel showCopy={false} value={approval.id} />
                  <div className="inline-actions">
                    <button
                      className="ghost-button"
                      disabled={!canDecide || actionPending}
                      onClick={() => void handleDecision(approval, "reject")}
                      type="button"
                    >
                      <X size={16} />
                      Deny
                    </button>
                    <button
                      className="primary-button"
                      disabled={!canDecide || actionPending}
                      onClick={() => void handleDecision(approval, "approve")}
                      type="button"
                    >
                      <Check size={16} />
                      Approve
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
