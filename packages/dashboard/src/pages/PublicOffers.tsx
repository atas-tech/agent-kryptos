import { Check, RefreshCw, ShieldAlert, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

interface IntentExchangeState {
  status: string;
  fulfilled_by: string | null;
  expires_at: string | null;
}

interface IntentAgentDeliveryState {
  state: string | null;
  recoverable: boolean;
  failure_reason: string | null;
  failed_at: string | null;
  last_dispatched_at: string | null;
  attempt_count: number;
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
  status: "pending_approval" | "payment_required" | "activated" | "rejected" | "revoked" | "expired";
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
  exchange_state: IntentExchangeState | null;
  agent_delivery: IntentAgentDeliveryState | null;
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
    return "";
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
  | { type: "intent_revoke"; intent: GuestIntentRecord }
  | { type: "intent_retry_agent_delivery"; intent: GuestIntentRecord };

function actionDialogCopy(
  action: IntentAction,
  t: (key: string, options?: Record<string, unknown>) => string
): {
  title: string;
  body: string;
  confirmLabel: string;
  tone: "danger" | "neutral";
} {
  if (action.type === "offer_revoke") {
    return {
      title: t("offers:confirm.revokeOfferTitle"),
      body: t("offers:confirm.revokeOfferBody", { label: formatOfferLabel(action.offer) }),
      confirmLabel: t("offers:confirm.revokeOfferLabel"),
      tone: "danger"
    };
  }

  if (action.type === "intent_approve") {
    return {
      title: t("offers:confirm.approveIntentTitle"),
      body: t("offers:confirm.approveIntentBody"),
      confirmLabel: t("offers:confirm.approveIntentLabel"),
      tone: "neutral"
    };
  }

  if (action.type === "intent_reject") {
    return {
      title: t("offers:confirm.rejectIntentTitle"),
      body: t("offers:confirm.rejectIntentBody"),
      confirmLabel: t("offers:confirm.rejectIntentLabel"),
      tone: "danger"
    };
  }

  if (action.type === "intent_retry_agent_delivery") {
    return {
      title: t("offers:confirm.retryDeliveryTitle"),
      body: t("offers:confirm.retryDeliveryBody"),
      confirmLabel: t("offers:confirm.retryDeliveryLabel"),
      tone: "neutral"
    };
  }

  return {
    title: t("offers:confirm.revokeIntentTitle"),
    body: t("offers:confirm.revokeIntentBody"),
    confirmLabel: t("offers:confirm.revokeIntentLabel"),
    tone: "danger"
  };
}

function intentStatusLabel(
  status: GuestIntentRecord["effective_status"],
  t: (key: string) => string
): string {
  switch (status) {
    case "pending_approval":
      return t("offers:intents.pendingApproval");
    case "payment_required":
      return t("offers:intents.paymentRequired");
    case "activated":
      return t("offers:intents.activated");
    case "expired":
      return t("offers:intents.expired");
    case "rejected":
      return t("offers:intents.rejected");
    case "revoked":
      return t("offers:intents.revoked");
    default:
      return status;
  }
}

function paymentStatusLabel(
  status: IntentPaymentSummary["status"],
  t: (key: string) => string
): string {
  switch (status) {
    case "pending":
      return t("offers:payments.pending");
    case "verified":
      return t("offers:payments.verified");
    case "settled":
      return t("offers:payments.settled");
    case "failed":
      return t("offers:payments.failed");
    case null:
      return t("offers:intents.paymentNone");
    default:
      return t("offers:payments.unknown");
  }
}

function actorTypeLabel(
  actorType: GuestIntentRecord["actor_type"],
  t: (key: string) => string
): string {
  return actorType === "guest_human" ? t("offers:intents.guestHuman") : t("offers:intents.guestAgent");
}

function approvalStatusLabel(
  status: GuestIntentRecord["approval_status"],
  t: (key: string) => string
): string {
  switch (status) {
    case "pending":
      return t("offers:intentDetail.approvalPending");
    case "approved":
      return t("offers:intentDetail.approvalApproved");
    case "rejected":
      return t("offers:intentDetail.approvalRejected");
    default:
      return t("offers:intentDetail.notRequired");
  }
}

export function PublicOffersPage() {
  const { t } = useTranslation(["offers", "common"]);
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
      setError(requestError instanceof Error ? requestError.message : t("offers:errors.loadOffersFailed"));
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
      setError(requestError instanceof Error ? requestError.message : t("offers:errors.loadIntentsFailed"));
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
      setError(requestError instanceof Error ? requestError.message : t("offers:errors.loadDetailFailed"));
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
      } else if (confirmAction.type === "intent_retry_agent_delivery") {
        await apiRequest(`/api/v2/public/intents/${confirmAction.intent.id}/retry-agent-delivery`, { method: "POST" });
      } else {
        await apiRequest(`/api/v2/public/intents/${confirmAction.intent.id}/revoke`, { method: "POST" });
      }

      await loadIntents();
      if (selectedIntentId) {
        await loadIntentDetail(selectedIntentId);
      }
      setConfirmAction(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("offers:errors.actionFailed"));
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
                  {t("offers:actions.reject")}
                </button>
                <button className="primary-button" onClick={() => setConfirmAction({ type: "intent_approve", intent: selectedIntent })} type="button">
                  <Check size={16} />
                  {t("offers:actions.approve")}
                </button>
              </div>
            )
          : (selectedIntent.effective_status !== "revoked" && selectedIntent.effective_status !== "expired" && selectedIntent.effective_status !== "rejected")
            ? (
                <div className="inline-actions">
                  {selectedIntent.agent_delivery?.recoverable ? (
                    <button className="ghost-button" onClick={() => setConfirmAction({ type: "intent_retry_agent_delivery", intent: selectedIntent })} type="button">
                      <RefreshCw size={16} />
                      {t("offers:actions.retryDelivery")}
                    </button>
                  ) : null}
                  <button className="ghost-button" onClick={() => setConfirmAction({ type: "intent_revoke", intent: selectedIntent })} type="button">
                    <Undo2 size={16} />
                    {t("offers:actions.revokeIntent")}
                  </button>
                </div>
              )
            : null
      )
    : null;

  const dialogCopy = confirmAction ? actionDialogCopy(confirmAction, t) : null;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">{t("offers:hero.sectionLabel")}</div>
            <h2 className="hero-card__title">{t("offers:hero.title")}</h2>
            <p className="hero-card__body">{t("offers:hero.body")}</p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => { void loadOffers(); void loadIntents(); }} type="button">
              <RefreshCw size={16} />
              {t("offers:actions.refresh")}
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("offers:stats.publicOffers")}</span>
            <strong>{offers.length}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("offers:stats.pendingApprovals")}</span>
            <strong>{pendingApprovals}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("offers:stats.activatedIntents")}</span>
            <strong>{activeIntentCount}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("offers:stats.settledPayments")}</span>
            <strong>{settledPayments}</strong>
          </article>
        </div>
      </div>

      {!canManage ? (
        <div className="panel-card approvals-viewer-note">
          <ShieldAlert size={18} />
          <div>
            <div className="record-title">{t("offers:viewerNote.title")}</div>
            <div className="panel-card__body">{t("offers:viewerNote.body")}</div>
          </div>
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="support-layout">
        <div className="panel-card support-column">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("offers:offers.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("offers:offers.title")}</h3>
              <p className="panel-card__body">{t("offers:offers.body")}</p>
            </div>

            <div className="toolbar__filters">
              <select
                aria-label={t("offers:offers.filterLabel")}
                className="dashboard-select"
                onChange={(event) => setSelectedOfferId(event.target.value)}
                value={selectedOfferId}
              >
                <option value="all">{t("offers:offers.allOffers")}</option>
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
                header: t("offers:offers.columnOffer"),
                render: (offer) => (
                  <div>
                    <div className="record-title">{formatOfferLabel(offer)}</div>
                    <div className="record-meta">{offer.secret_name ?? t("offers:offers.noSecretPinned")}</div>
                  </div>
                )
              },
              {
                key: "policy",
                header: t("offers:offers.columnPolicy"),
                render: (offer) => (
                  <div>
                    <div>{offer.delivery_mode}</div>
                    <div className="record-meta">{offer.payment_policy}</div>
                  </div>
                )
              },
              {
                key: "status",
                header: t("offers:offers.columnStatus"),
                render: (offer) => <StatusBadge tone={toneForOfferStatus(offer.status)}>{offer.status}</StatusBadge>
              },
              {
                key: "usage",
                header: t("offers:offers.columnUsage"),
                render: (offer) => (
                  <strong>
                    {offer.max_uses === null
                      ? t("offers:offers.usedCount", { used: offer.used_count })
                      : t("offers:offers.usedOfMax", { used: offer.used_count, max: offer.max_uses })}
                  </strong>
                )
              }
            ]}
            emptyState={
              <EmptyState
                title={t("offers:offers.emptyTitle")}
                body={t("offers:offers.emptyBody")}
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
                  <span className="meta-label">{t("offers:offerDetail.offerId")}</span>
                  <ResourceLabel value={selectedOffer.id} />
                </div>
                <div className="detail-list__item">
                  <span className="meta-label">{t("offers:offerDetail.expires")}</span>
                  <strong>{formatDate(selectedOffer.expires_at) || t("common:notAvailable")}</strong>
                </div>
                <div className="detail-list__item">
                  <span className="meta-label">{t("offers:offerDetail.price")}</span>
                  <strong>{selectedOffer.payment_policy === "free" ? t("offers:offerDetail.free") : centsLabel(selectedOffer.price_usd_cents)}</strong>
                </div>
                <div className="detail-list__item">
                  <span className="meta-label">{t("offers:offerDetail.approval")}</span>
                  <strong>{selectedOffer.require_approval ? t("offers:offerDetail.required") : t("offers:offerDetail.directAllow")}</strong>
                </div>
              </div>

              {canManage && selectedOffer.status === "active" ? (
                <div className="support-actions">
                  <button className="ghost-button" onClick={() => setConfirmAction({ type: "offer_revoke", offer: selectedOffer })} type="button">
                    <Undo2 size={16} />
                    {t("offers:offerDetail.revokeOffer")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="panel-card support-column">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("offers:intents.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("offers:intents.title")}</h3>
              <p className="panel-card__body">{t("offers:intents.body")}</p>
            </div>

            <div className="toolbar__filters">
              <select
                aria-label={t("offers:intents.filterLabel")}
                className="dashboard-select"
                onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
                value={statusFilter}
              >
                <option value="all">{t("offers:intents.allStates")}</option>
                <option value="pending_approval">{t("offers:intents.pendingApproval")}</option>
                <option value="payment_required">{t("offers:intents.paymentRequired")}</option>
                <option value="activated">{t("offers:intents.activated")}</option>
                <option value="expired">{t("offers:intents.expired")}</option>
                <option value="rejected">{t("offers:intents.rejected")}</option>
                <option value="revoked">{t("offers:intents.revoked")}</option>
              </select>
            </div>
          </div>

          <DataTable
            columns={[
              {
                key: "intent",
                header: t("offers:intents.columnRequester"),
                render: (intent) => (
                  <div>
                    <div className="record-title">{intent.requester_label || actorTypeLabel(intent.actor_type, t)}</div>
                    <div className="record-meta">{intent.resolved_secret_name}</div>
                  </div>
                )
              },
              {
                key: "status",
                header: t("offers:intents.columnLifecycle"),
                render: (intent) => (
                  <StatusBadge tone={toneForIntentStatus(intent.effective_status)}>
                    {intentStatusLabel(intent.effective_status, t)}
                  </StatusBadge>
                )
              },
              {
                key: "payment",
                header: t("offers:intents.columnPayment"),
                render: (intent) => (
                  intent.latest_payment
                    ? (
                        <StatusBadge tone={toneForPaymentStatus(intent.latest_payment.status)}>
                          {paymentStatusLabel(intent.latest_payment.status, t)}
                        </StatusBadge>
                      )
                    : <span className="record-meta">{t("offers:intents.paymentNone")}</span>
                )
              },
              {
                key: "created",
                header: t("offers:intents.columnCreated"),
                render: (intent) => <strong>{formatDate(intent.created_at) || t("common:notAvailable")}</strong>
              }
            ]}
            emptyState={
              <EmptyState
                title={t("offers:intents.emptyTitle")}
                body={selectedOffer ? t("offers:intents.emptyBodyFiltered") : t("offers:intents.emptyBodyDefault")}
              />
            }
            expandedRowKey={selectedIntentId}
            loading={loadingIntents}
            onRowClick={(intent) => setSelectedIntentId(intent.id)}
            renderExpandedRow={(intent) => (
              <div className="audit-expanded">
                <div className="detail-list">
                  <div className="detail-list__item">
                    <span className="meta-label">{t("offers:intentDetail.purpose")}</span>
                    <strong>{intent.purpose}</strong>
                  </div>
                  <div className="detail-list__item">
                    <span className="meta-label">{t("offers:intentDetail.requestState")}</span>
                    <strong>{intent.request_state?.status ?? t("offers:intentDetail.notIssued")}</strong>
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
            <div className="section-label">{t("offers:intentDetail.sectionLabel")}</div>
            <h3 className="panel-card__title">{t("offers:intentDetail.title")}</h3>
            <p className="panel-card__body">{t("offers:intentDetail.body")}</p>
          </div>
          {detailAction}
        </div>

        {loadingDetail ? (
          <div className="empty-state">
            <div className="empty-state__eyebrow">{t("common:loading")}</div>
            <h3>{t("offers:intentDetail.loadingTitle")}</h3>
            <p>{t("offers:intentDetail.loadingBody")}</p>
          </div>
        ) : !selectedIntent ? (
          <EmptyState
            title={t("offers:intentDetail.emptyTitle")}
            body={t("offers:intentDetail.emptyBody")}
          />
        ) : (
          <div className="support-detail-grid">
            <div className="detail-list">
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.intentId")}</span>
                <ResourceLabel value={selectedIntent.id} />
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.offer")}</span>
                <strong>{selectedIntent.offer_label || selectedIntent.resolved_secret_name}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.lifecycle")}</span>
                <strong>{intentStatusLabel(selectedIntent.effective_status, t)}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.approval")}</span>
                <strong>{approvalStatusLabel(selectedIntent.approval_status, t)}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.delivery")}</span>
                <strong>{selectedIntent.delivery_mode}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.price")}</span>
                <strong>{selectedIntent.payment_policy === "free" ? t("offers:offerDetail.free") : centsLabel(selectedIntent.price_usd_cents)}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.requestState")}</span>
                <strong>{selectedIntent.request_state?.status ?? t("offers:intentDetail.notIssued")}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.requestId")}</span>
                {selectedIntent.request_id ? <ResourceLabel value={selectedIntent.request_id} /> : <strong>{t("common:notAvailable")}</strong>}
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.exchangeState")}</span>
                <strong>{selectedIntent.exchange_state?.status ?? t("common:notAvailable")}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.exchangeId")}</span>
                {selectedIntent.exchange_id ? <ResourceLabel value={selectedIntent.exchange_id} /> : <strong>{t("common:notAvailable")}</strong>}
              </div>
            </div>

            <div className="support-detail-stack">
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.purpose")}</span>
                <strong>{selectedIntent.purpose}</strong>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.latestPayment")}</span>
                <div className="support-payment-row">
                  <StatusBadge tone={toneForPaymentStatus(selectedIntent.latest_payment?.status ?? null)}>
                    {paymentStatusLabel(selectedIntent.latest_payment?.status ?? null, t)}
                  </StatusBadge>
                  {selectedIntent.latest_payment?.payment_id ? <ResourceLabel value={selectedIntent.latest_payment.payment_id} /> : null}
                </div>
                <div className="record-meta">
                  {selectedIntent.latest_payment?.tx_hash
                    ? t("offers:intentDetail.txHash", { hash: selectedIntent.latest_payment.tx_hash })
                    : t("offers:intentDetail.noPayment")}
                </div>
              </div>
              <div className="detail-list__item">
                <span className="meta-label">{t("offers:intentDetail.timestamps")}</span>
                <div className="support-timestamp-list">
                  <div>{t("offers:intentDetail.created", { date: formatDate(selectedIntent.created_at) || t("common:notAvailable") })}</div>
                  <div>{t("offers:intentDetail.activated", { date: formatDate(selectedIntent.activated_at) || t("common:notAvailable") })}</div>
                  <div>{t("offers:intentDetail.expires", { date: formatDate(selectedIntent.expires_at) || t("common:notAvailable") })}</div>
                  <div>{t("offers:intentDetail.updated", { date: formatDate(selectedIntent.updated_at) || t("common:notAvailable") })}</div>
                </div>
              </div>
              {selectedIntent.agent_delivery ? (
                <div className="detail-list__item">
                  <span className="meta-label">{t("offers:intentDetail.agentDelivery")}</span>
                  <div className="support-payment-row">
                    <StatusBadge tone={selectedIntent.agent_delivery.recoverable ? "warning" : "neutral"}>
                      {selectedIntent.agent_delivery.state ?? t("common:notAvailable")}
                    </StatusBadge>
                    <span className="record-meta">{t("offers:intentDetail.attempt", { count: selectedIntent.agent_delivery.attempt_count })}</span>
                  </div>
                  <div className="record-meta">
                    {selectedIntent.agent_delivery.failure_reason
                      ? t("offers:intentDetail.failureReason", { reason: selectedIntent.agent_delivery.failure_reason })
                      : selectedIntent.exchange_state?.fulfilled_by
                        ? t("offers:intentDetail.fulfilledBy", { agent: selectedIntent.exchange_state.fulfilled_by })
                        : t("offers:intentDetail.noDeliveryFailure")}
                  </div>
                </div>
              ) : null}
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
