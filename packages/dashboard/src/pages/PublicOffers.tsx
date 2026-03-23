import { Check, RefreshCw, ShieldAlert, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DataTable } from "../components/DataTable.js";
import { EmptyState } from "../components/EmptyState.js";
import { ResourceLabel } from "../components/ResourceLabel.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface OfferRecord {
  id: string;
  workspace_id: string;
  created_by_user_id: string;
  offer_label: string | null;
  delivery_mode: "human" | "agent" | "either";
  payment_policy: "free" | "always_x402" | "quota_then_x402";
  price_usd_cents: number;
  included_free_uses: number;
  secret_name: string | null;
  allowed_fulfiller_id: string | null;
  require_approval: boolean;
  status: "active" | "revoked";
  max_uses: number | null;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IntentPaymentSummary {
  payment_id: string;
  status: "pending" | "verified" | "settled" | "failed" | null;
  tx_hash: string | null;
  settled_at: string | null;
  created_at: string | null;
}

interface IntentRequestState {
  status: "pending" | "submitted";
  expires_at: string;
}

interface GuestIntentRecord {
  id: string;
  workspace_id: string;
  offer_id: string;
  offer_label: string | null;
  offer_status: "active" | "revoked";
  offer_used_count: number;
  offer_max_uses: number | null;
  offer_expires_at: string;
  actor_type: "guest_agent" | "guest_human";
  status: "pending_approval" | "payment_required" | "activated" | "rejected" | "revoked";
  effective_status: "pending_approval" | "payment_required" | "activated" | "rejected" | "revoked" | "expired";
  approval_status: "pending" | "approved" | "rejected" | null;
  approval_reference: string | null;
  requester_label: string | null;
  purpose: string;
  delivery_mode: "human" | "agent" | "either";
  payment_policy: "free" | "always_x402" | "quota_then_x402";
  price_usd_cents: number;
  included_free_uses: number;
  resolved_secret_name: string;
  allowed_fulfiller_id: string | null;
  request_id: string | null;
  request_state: IntentRequestState | null;
  exchange_id: string | null;
  activated_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  latest_payment: IntentPaymentSummary | null;
}

interface OffersResponse {
  offers: OfferRecord[];
}

interface IntentsResponse {
  intents: GuestIntentRecord[];
}

interface IntentDetailResponse {
  intent: GuestIntentRecord;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatDate(value: string | null): string {
  if (!value) {
    return "n/a";
  }

  return dateFormatter.format(new Date(value));
}

function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function toneForOfferStatus(status: OfferRecord["status"]): "success" | "warning" {
  return status === "active" ? "success" : "warning";
}

function toneForIntentStatus(status: GuestIntentRecord["effective_status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "activated") {
    return "success";
  }

  if (status === "pending_approval" || status === "payment_required" || status === "expired") {
    return "warning";
  }

  if (status === "rejected" || status === "revoked") {
    return "danger";
  }

  return "neutral";
}

function toneForPaymentStatus(status: IntentPaymentSummary["status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "settled") {
    return "success";
  }

  if (status === "pending" || status === "verified") {
    return "warning";
  }

  if (status === "failed") {
    return "danger";
  }

  return "neutral";
}

function formatOfferLabel(offer: OfferRecord): string {
  return offer.offer_label?.trim() || offer.secret_name || offer.id;
}

type IntentAction =
  | { type: "offer_revoke"; offer: OfferRecord }
  | { type: "intent_approve"; intent: GuestIntentRecord }
  | { type: "intent_reject"; intent: GuestIntentRecord }
  | { type: "intent_revoke"; intent: GuestIntentRecord };

function actionDialogCopy(action: IntentAction): {
  title: string;
  body: string;
  confirmLabel: string;
  tone: "danger" | "neutral";
} {
  if (action.type === "offer_revoke") {
    return {
      title: "Revoke public offer",
      body: `This disables ${formatOfferLabel(action.offer)} for new guest requests immediately.`,
      confirmLabel: "Revoke offer",
      tone: "danger"
    };
  }

  if (action.type === "intent_approve") {
    return {
      title: "Approve guest intent",
      body: "This makes the pending guest request payable or directly activatable according to the offer policy.",
      confirmLabel: "Approve intent",
      tone: "neutral"
    };
  }

  if (action.type === "intent_reject") {
    return {
      title: "Reject guest intent",
      body: "This permanently denies the current guest request without exposing any secret material.",
      confirmLabel: "Reject intent",
      tone: "danger"
    };
  }

  return {
    title: "Revoke guest intent",
    body: "This invalidates any active fulfill path for the guest request and prevents later retrieval.",
    confirmLabel: "Revoke intent",
    tone: "danger"
  };
}

export function PublicOffersPage() {
  const { user } = useAuth();
  const [offers, setOffers] = useState<OfferRecord[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | GuestIntentRecord["effective_status"]>("all");
  const [intents, setIntents] = useState<GuestIntentRecord[]>([]);
  const [selectedIntentId, setSelectedIntentId] = useState<string | null>(null);
  const [selectedIntent, setSelectedIntent] = useState<GuestIntentRecord | null>(null);
  const [loadingOffers, setLoadingOffers] = useState(true);
  const [loadingIntents, setLoadingIntents] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<IntentAction | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const canManage = user?.role === "workspace_admin" || user?.role === "workspace_operator";

  useEffect(() => {
    void loadOffers();
  }, []);

  useEffect(() => {
    if (offers.length === 0 && selectedOfferId !== "all") {
      setSelectedOfferId("all");
    }
  }, [offers, selectedOfferId]);

  useEffect(() => {
    void loadIntents();
  }, [selectedOfferId, statusFilter]);

  useEffect(() => {
    if (!selectedIntentId) {
      setSelectedIntent(null);
      return;
    }

    void loadIntentDetail(selectedIntentId);
  }, [selectedIntentId]);

  async function loadOffers(): Promise<void> {
    setLoadingOffers(true);
    setError(null);

    try {
      const payload = await apiRequest<OffersResponse>("/api/v2/public/offers");
      setOffers(payload.offers);
      if (payload.offers.length > 0 && selectedOfferId !== "all" && !payload.offers.some((offer) => offer.id === selectedOfferId)) {
        setSelectedOfferId("all");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load public offers");
      setOffers([]);
    } finally {
      setLoadingOffers(false);
    }
  }

  async function loadIntents(): Promise<void> {
    setLoadingIntents(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("limit", "100");
      if (selectedOfferId !== "all") {
        params.set("offer_id", selectedOfferId);
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }

      const payload = await apiRequest<IntentsResponse>(`/api/v2/public/intents/admin?${params.toString()}`);
      setIntents(payload.intents);

      if (payload.intents.length === 0) {
        setSelectedIntentId(null);
        return;
      }

      if (!selectedIntentId || !payload.intents.some((intent) => intent.id === selectedIntentId)) {
        setSelectedIntentId(payload.intents[0].id);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load guest intents");
      setIntents([]);
      setSelectedIntentId(null);
    } finally {
      setLoadingIntents(false);
    }
  }

  async function loadIntentDetail(intentId: string): Promise<void> {
    setLoadingDetail(true);

    try {
      const payload = await apiRequest<IntentDetailResponse>(`/api/v2/public/intents/admin/${intentId}`);
      setSelectedIntent(payload.intent);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load guest intent detail");
      setSelectedIntent(null);
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleConfirmAction(): Promise<void> {
    if (!confirmAction) {
      return;
    }

    setActionPending(true);
    setError(null);

    try {
      if (confirmAction.type === "offer_revoke") {
        await apiRequest(`/api/v2/public/offers/${confirmAction.offer.id}/revoke`, { method: "POST" });
        await loadOffers();
      } else if (confirmAction.type === "intent_approve") {
        await apiRequest(`/api/v2/public/intents/${confirmAction.intent.id}/approve`, { method: "POST" });
      } else if (confirmAction.type === "intent_reject") {
        await apiRequest(`/api/v2/public/intents/${confirmAction.intent.id}/reject`, { method: "POST" });
      } else {
        await apiRequest(`/api/v2/public/intents/${confirmAction.intent.id}/revoke`, { method: "POST" });
      }

      await loadIntents();
      if (selectedIntentId) {
        await loadIntentDetail(selectedIntentId);
      }
      setConfirmAction(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update guest access state");
    } finally {
      setActionPending(false);
    }
  }

  const selectedOffer = selectedOfferId === "all"
    ? null
    : offers.find((offer) => offer.id === selectedOfferId) ?? null;
  const pendingApprovals = intents.filter((intent) => intent.effective_status === "pending_approval").length;
  const activeIntentCount = intents.filter((intent) => intent.effective_status === "activated").length;
  const settledPayments = intents.filter((intent) => intent.latest_payment?.status === "settled").length;

  const detailAction = selectedIntent && canManage
    ? (
        selectedIntent.effective_status === "pending_approval"
          ? (
              <div className="inline-actions">
                <button className="ghost-button" onClick={() => setConfirmAction({ type: "intent_reject", intent: selectedIntent })} type="button">
                  <X size={16} />
                  Reject
                </button>
                <button className="primary-button" onClick={() => setConfirmAction({ type: "intent_approve", intent: selectedIntent })} type="button">
                  <Check size={16} />
                  Approve
                </button>
              </div>
            )
          : (selectedIntent.effective_status !== "revoked" && selectedIntent.effective_status !== "expired" && selectedIntent.effective_status !== "rejected")
            ? (
                <button className="ghost-button" onClick={() => setConfirmAction({ type: "intent_revoke", intent: selectedIntent })} type="button">
                  <Undo2 size={16} />
                  Revoke intent
                </button>
              )
            : null
      )
    : null;

  const dialogCopy = confirmAction ? actionDialogCopy(confirmAction) : null;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">Phase 3C</div>
            <h2 className="hero-card__title">Public offers and guest requests</h2>
            <p className="hero-card__body">
              Inspect public guest-access offers, payment state, approval backlog, and live fulfill handoffs without exposing
              secret payloads, guest tokens, or raw request links.
            </p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => { void loadOffers(); void loadIntents(); }} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Public offers</span>
            <strong>{offers.length}</strong>
          </article>
          <article className="metric-panel">
            <span>Pending approvals</span>
            <strong>{pendingApprovals}</strong>
          </article>
          <article className="metric-panel">
            <span>Activated intents</span>
            <strong>{activeIntentCount}</strong>
          </article>
          <article className="metric-panel">
            <span>Settled payments</span>
            <strong>{settledPayments}</strong>
          </article>
        </div>
      </div>

      {!canManage ? (
        <div className="panel-card approvals-viewer-note">
          <ShieldAlert size={18} />
          <div>
            <div className="record-title">Viewer access is read-only</div>
            <div className="panel-card__body">
              You can inspect public offers and guest-request lifecycle details here, but only admins and operators can make changes.
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="support-layout">
        <div className="panel-card support-column">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Workspace offers</div>
              <h3 className="panel-card__title">Offer inventory</h3>
              <p className="panel-card__body">
                Filter the guest queue by a specific offer, inspect capacity, and disable abused or obsolete offers.
              </p>
            </div>

            <div className="toolbar__filters">
              <select
                aria-label="Filter guest intents by offer"
                className="dashboard-select"
                onChange={(event) => setSelectedOfferId(event.target.value)}
                value={selectedOfferId}
              >
                <option value="all">All offers</option>
                {offers.map((offer) => (
                  <option key={offer.id} value={offer.id}>{formatOfferLabel(offer)}</option>
                ))}
              </select>
            </div>
          </div>

          <DataTable
            columns={[
              {
                key: "offer",
                header: "Offer",
                render: (offer) => (
                  <div>
                    <div className="record-title">{formatOfferLabel(offer)}</div>
                    <div className="record-meta">{offer.secret_name ?? "no secret pinned"}</div>
                  </div>
                )
              },
              {
                key: "policy",
                header: "Policy",
                render: (offer) => (
                  <div>
                    <div>{offer.delivery_mode}</div>
                    <div className="record-meta">{offer.payment_policy}</div>
                  </div>
                )
              },
              {
                key: "status",
                header: "Status",
                render: (offer) => <StatusBadge tone={toneForOfferStatus(offer.status)}>{offer.status}</StatusBadge>
              },
              {
                key: "usage",
                header: "Usage",
                render: (offer) => (
                  <strong>{offer.max_uses === null ? `${offer.used_count} used` : `${offer.used_count}/${offer.max_uses}`}</strong>
                )
              }
            ]}
            emptyState={
              <EmptyState
                title="No public offers"
                body="Create guest-facing offers from the operator API to expose them here for support and triage."
              />
            }
            loading={loadingOffers}
            onRowClick={(offer) => setSelectedOfferId((current) => current === offer.id ? "all" : offer.id)}
            rowKey={(offer) => offer.id}
            rows={offers}
          />

          {selectedOffer ? (
            <div className="support-summary">
              <div className="detail-list">
                <div className="detail-list__item">
                  <span className="meta-label">Offer ID</span>
                  <ResourceLabel value={selectedOffer.id} />
                </div>
                <div className="detail-list__item">
                  <span className="meta-label">Expires</span>
                  <strong>{formatDate(selectedOffer.expires_at)}</strong>
                </div>
                <div className="detail-list__item">
                  <span className="meta-label">Price</span>
                  <strong>{selectedOffer.payment_policy === "free" ? "Free" : centsLabel(selectedOffer.price_usd_cents)}</strong>
                </div>
                <div className="detail-list__item">
                  <span className="meta-label">Approval</span>
                  <strong>{selectedOffer.require_approval ? "Required" : "Direct allow"}</strong>
                </div>
              </div>

              {canManage && selectedOffer.status === "active" ? (
                <div className="support-actions">
                  <button className="ghost-button" onClick={() => setConfirmAction({ type: "offer_revoke", offer: selectedOffer })} type="button">
                    <Undo2 size={16} />
                    Revoke offer
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="panel-card support-column">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Guest queue</div>
              <h3 className="panel-card__title">Guest intents</h3>
              <p className="panel-card__body">
                Review approval state, payment outcome, and request lifecycle without exposing guest token or fulfill-link material.
              </p>
            </div>

            <div className="toolbar__filters">
              <select
                aria-label="Filter guest intents by status"
                className="dashboard-select"
                onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
                value={statusFilter}
              >
                <option value="all">All intent states</option>
                <option value="pending_approval">Pending approval</option>
                <option value="payment_required">Payment required</option>
                <option value="activated">Activated</option>
                <option value="expired">Expired</option>
                <option value="rejected">Rejected</option>
                <option value="revoked">Revoked</option>
              </select>
            </div>
          </div>

          <DataTable
            columns={[
              {
                key: "intent",
                header: "Requester",
                render: (intent) => (
                  <div>
                    <div className="record-title">{intent.requester_label || intent.actor_type.replace("guest_", "guest ")}</div>
                    <div className="record-meta">{intent.resolved_secret_name}</div>
                  </div>
                )
              },
              {
                key: "status",
                header: "Lifecycle",
                render: (intent) => <StatusBadge tone={toneForIntentStatus(intent.effective_status)}>{intent.effective_status}</StatusBadge>
              },
              {
                key: "payment",
                header: "Payment",
                render: (intent) => (
                  intent.latest_payment
                    ? <StatusBadge tone={toneForPaymentStatus(intent.latest_payment.status)}>{intent.latest_payment.status ?? "unknown"}</StatusBadge>
                    : <span className="record-meta">none</span>
                )
              },
              {
                key: "created",
                header: "Created",
                render: (intent) => <strong>{formatDate(intent.created_at)}</strong>
              }
            ]}
            emptyState={
              <EmptyState
                title="No guest intents"
                body={selectedOffer ? "No guest requests match the selected offer and status filters." : "No guest requests have been created for this workspace yet."}
              />
            }
            expandedRowKey={selectedIntentId}
            loading={loadingIntents}
            onRowClick={(intent) => setSelectedIntentId(intent.id)}
            renderExpandedRow={(intent) => (
              <div className="audit-expanded">
                <div className="detail-list">
                  <div className="detail-list__item">
                    <span className="meta-label">Purpose</span>
                    <strong>{intent.purpose}</strong>
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">Request state</span>
                    <strong>{intent.request_state?.status ?? "not issued"}</strong>
                  </div>
                </div>
              </div>
            )}
            rowKey={(intent) => intent.id}
            rows={intents}
          />
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">Intent detail</div>
            <h3 className="panel-card__title">Selected guest request</h3>
            <p className="panel-card__body">
              Drill into the current support record. This view intentionally excludes guest tokens, fulfill URLs, and any submitted payload data.
            </p>
          </div>
          {detailAction}
        </div>

        {loadingDetail ? (
          <div className="empty-state">
            <div className="empty-state__eyebrow">Loading</div>
            <h3>Refreshing guest request detail</h3>
            <p>Reading the latest offer, payment, and request-state summary.</p>
          </div>
        ) : !selectedIntent ? (
          <EmptyState
            title="No guest request selected"
            body="Choose a guest intent from the queue to inspect its support detail."
          />
        ) : (
          <div className="support-detail-grid">
            <div className="detail-list">
              <div className="detail-list__item">
                <span className="meta-label">Intent ID</span>
                <ResourceLabel value={selectedIntent.id} />
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Offer</span>
                <strong>{selectedIntent.offer_label || selectedIntent.resolved_secret_name}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Lifecycle</span>
                <strong>{selectedIntent.effective_status}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Approval</span>
                <strong>{selectedIntent.approval_status ?? "not required"}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Delivery</span>
                <strong>{selectedIntent.delivery_mode}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Price</span>
                <strong>{selectedIntent.payment_policy === "free" ? "Free" : centsLabel(selectedIntent.price_usd_cents)}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Request state</span>
                <strong>{selectedIntent.request_state?.status ?? "not issued"}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Request ID</span>
                {selectedIntent.request_id ? <ResourceLabel value={selectedIntent.request_id} /> : <strong>n/a</strong>}
              </div>
            </div>

            <div className="support-detail-stack">
              <div className="detail-list__item">
                <span className="meta-label">Purpose</span>
                <strong>{selectedIntent.purpose}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Latest payment</span>
                <div className="support-payment-row">
                  <StatusBadge tone={toneForPaymentStatus(selectedIntent.latest_payment?.status ?? null)}>
                    {selectedIntent.latest_payment?.status ?? "none"}
                  </StatusBadge>
                  {selectedIntent.latest_payment?.payment_id ? <ResourceLabel value={selectedIntent.latest_payment.payment_id} /> : null}
                </div>
                <div className="record-meta">
                  {selectedIntent.latest_payment?.tx_hash ? `tx ${selectedIntent.latest_payment.tx_hash}` : "No payment settlement recorded"}
                </div>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">Timestamps</span>
                <div className="support-timestamp-list">
                  <div>Created {formatDate(selectedIntent.created_at)}</div>
                  <div>Activated {formatDate(selectedIntent.activated_at)}</div>
                  <div>Expires {formatDate(selectedIntent.expires_at)}</div>
                  <div>Updated {formatDate(selectedIntent.updated_at)}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {confirmAction && dialogCopy ? (
        <ConfirmDialog
          body={dialogCopy.body}
          confirmLabel={dialogCopy.confirmLabel}
          onCancel={() => setConfirmAction(null)}
          onConfirm={handleConfirmAction}
          open
          pending={actionPending}
          title={dialogCopy.title}
          tone={dialogCopy.tone}
        />
      ) : null}
    </section>
  );
}
