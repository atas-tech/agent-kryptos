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
  actor_type: "user" | "agent" | "system" | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AuditListResponse {
  records: AuditRecord[];
  next_cursor: string | null;
}

interface ApprovalCard {
  approvalReference: string;
  requesterId: string;
  fulfillerHint: string;
  secretName: string;
  purpose: string;
  ruleId: string;
  requestedAt: string;
  expiresAt: string;
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
      const params = new URLSearchParams({
        limit: "200",
        from: since
      });
      const payload = await apiRequest<AuditListResponse>(`/api/v2/audit?${params.toString()}`);
      const decidedReferences = new Set<string>();
      const pendingMap = new Map<string, ApprovalCard>();

      for (const record of payload.records) {
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
          approvalReference: record.resource_id,
          requesterId: extractString(record.metadata, "requester_id"),
          fulfillerHint: extractString(record.metadata, "fulfilled_by"),
          secretName: extractString(record.metadata, "secret_name"),
          purpose: extractString(record.metadata, "purpose"),
          ruleId: extractString(record.metadata, "policy_rule_id"),
          requestedAt: record.created_at,
          expiresAt: new Date(requestedAtMs + APPROVAL_TTL_MS).toISOString()
        });
      }

      const nextApprovals = Array.from(pendingMap.values())
        .filter((approval) => !decidedReferences.has(approval.approvalReference))
        .sort((left, right) => new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime());

      setApprovals(nextApprovals);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load approvals");
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleDecision(approvalReference: string, decision: "approve" | "reject"): Promise<void> {
    setActionPendingId(approvalReference);
    setActionError(null);
    setLastDecision(null);

    try {
      await apiRequest<{ approval_reference: string; status: string }>(
        `/api/v2/secret/exchange/admin/approval/${approvalReference}/${decision}`,
        { method: "POST" }
      );

      setApprovals((current) => current.filter((approval) => approval.approvalReference !== approvalReference));
      setLastDecision(`${decision === "approve" ? "Approved" : "Denied"} ${approvalReference}.`);
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

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">Milestone 4</div>
            <h2 className="hero-card__title">Approvals inbox</h2>
            <p className="hero-card__body">
              Pending A2A approvals are surfaced in the same Stitch card grid used for operations triage. Admins and
              operators can decide requests directly, while viewers stay read-only.
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
            <p>Collecting pending exchange approvals from the recent audit stream.</p>
          </div>
        </div>
      ) : approvals.length === 0 ? (
        <EmptyState
          body="No currently pending A2A approvals were found in the active workspace window."
          title="Inbox clear"
        />
      ) : (
        <div className="approval-grid">
          {approvals.map((approval) => {
            const actionPending = actionPendingId === approval.approvalReference;
            const expiringSoon = new Date(approval.expiresAt).getTime() - Date.now() <= 2 * 60 * 1000;

            return (
              <article key={approval.approvalReference} className="approval-card">
                <div className="approval-card__header">
                  <div>
                    <div className="section-label">Pending approval</div>
                    <h3 className="approval-card__title">{approval.secretName}</h3>
                  </div>
                  <StatusBadge tone={expiringSoon ? "warning" : "neutral"}>{expiringSoon ? "expiring" : "pending"}</StatusBadge>
                </div>

                <div className="detail-list">
                  <div className="detail-list__item">
                    <span className="meta-label">Requester agent</span>
                    <ResourceLabel value={approval.requesterId} />
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">Fulfiller agent</span>
                    <ResourceLabel value={approval.fulfillerHint} />
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">Requested at</span>
                    <strong>{formatTimestamp(approval.requestedAt)}</strong>
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">Rule</span>
                    <strong>{approval.ruleId}</strong>
                  </div>
                </div>

                <div className="approval-card__purpose">
                  <span className="meta-label">Purpose</span>
                  <p>{approval.purpose}</p>
                </div>

                <div className="approval-card__footer">
                  <ResourceLabel showCopy={false} value={approval.approvalReference} />
                  <div className="inline-actions">
                    <button
                      className="ghost-button"
                      disabled={!canDecide || actionPending}
                      onClick={() => void handleDecision(approval.approvalReference, "reject")}
                      type="button"
                    >
                      <X size={16} />
                      Deny
                    </button>
                    <button
                      className="primary-button"
                      disabled={!canDecide || actionPending}
                      onClick={() => void handleDecision(approval.approvalReference, "approve")}
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
