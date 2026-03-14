import { BadgeDollarSign, Coins, RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createBillingCheckoutSession,
  createBillingPortalSession
} from "../api/dashboard.js";
import { useAuth } from "../auth/useAuth.js";
import { QuotaMeter } from "../components/QuotaMeter.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useDashboardSummary } from "../hooks/useDashboardSummary.js";

export function BillingPage() {
  const { workspace, setWorkspaceSummary } = useAuth();
  const { summary, loading, error, refresh } = useDashboardSummary();
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (summary?.workspace) {
      // Only update if something actually changed to avoid infinite loop
      const changed = 
        summary.workspace.tier !== workspace?.tier ||
        summary.workspace.display_name !== workspace?.display_name ||
        summary.workspace.status !== workspace?.status;

      if (changed) {
        setWorkspaceSummary({
          ...workspace,
          ...summary.workspace,
          owner_user_id: workspace?.owner_user_id ?? "",
          created_at: workspace?.created_at ?? new Date(0).toISOString(),
          updated_at: workspace?.updated_at ?? new Date().toISOString()
        });
      }
    }
  }, [setWorkspaceSummary, summary?.workspace, workspace?.id, workspace?.tier, workspace?.display_name, workspace?.status]);

  async function handleCheckout(): Promise<void> {
    setCheckoutPending(true);
    setActionError(null);

    try {
      const payload = await createBillingCheckoutSession();
      window.location.assign(payload.checkout_url);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "Unable to start checkout");
    } finally {
      setCheckoutPending(false);
    }
  }

  async function handlePortal(): Promise<void> {
    setPortalPending(true);
    setActionError(null);

    try {
      const payload = await createBillingPortalSession();
      window.location.assign(payload.portal_url);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "Unable to open billing portal");
    } finally {
      setPortalPending(false);
    }
  }

  const isStandard = summary?.workspace.tier === "standard";

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div>
          <div className="section-label">Billing operations</div>
          <h2 className="hero-card__title">Billing and quota controls</h2>
          <p className="hero-card__body">
            Manage the recurring workspace subscription here. Agent-paid x402 overages remain a separate operational
            ledger and will arrive in a later milestone.
          </p>
        </div>
        <div className="hero-card__actions">
          <button className="ghost-button" disabled={loading} onClick={() => void refresh()} type="button">
            <RefreshCcw size={16} />
            Refresh
          </button>
          {isStandard ? (
            <button className="primary-button" disabled={portalPending || loading} onClick={() => void handlePortal()} type="button">
              <BadgeDollarSign size={16} />
              {portalPending ? "Opening portal..." : "Manage subscription"}
            </button>
          ) : (
            <button className="primary-button" disabled={checkoutPending || loading} onClick={() => void handleCheckout()} type="button">
              <BadgeDollarSign size={16} />
              {checkoutPending ? "Starting checkout..." : "Upgrade to Standard"}
            </button>
          )}
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {actionError ? <div className="error-banner">{actionError}</div> : null}

      {loading && !summary ? (
        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Recurring billing</div>
              <h3 className="panel-card__title">Loading billing overview</h3>
              <p className="panel-card__body">Reading workspace plan, customer reference, and daily usage.</p>
            </div>
          </div>
        </div>
      ) : null}

      {summary ? (
        <div className="section-grid">
          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Subscription</div>
                <h3 className="panel-card__title">Workspace plan</h3>
                <p className="panel-card__body">Recurring subscription billing stays provider-specific and separate from x402 request payments.</p>
              </div>
              <div className="inline-actions">
                <StatusBadge tone={isStandard ? "success" : "warning"}>
                  {summary.workspace.tier}
                </StatusBadge>
                <StatusBadge
                  tone={summary.billing.subscription_status === "active" ? "success" : "neutral"}
                >
                  {summary.billing.subscription_status}
                </StatusBadge>
              </div>
            </div>

            <div className="billing-summary-grid">
              <article className="metric-panel">
                <span>Provider</span>
                <strong>{summary.billing.billing_provider ?? "Not connected"}</strong>
              </article>
              <article className="metric-panel">
                <span>Customer reference</span>
                <strong>{summary.billing.provider_customer_id ?? "Pending checkout"}</strong>
              </article>
              <article className="metric-panel">
                <span>Subscription reference</span>
                <strong>{summary.billing.provider_subscription_id ?? "Pending checkout"}</strong>
              </article>
            </div>

            <div className="turnstile-placeholder">
              <BadgeDollarSign size={18} />
              <div>
                <strong>Simple billing path</strong>
                <span>Stripe manages recurring subscriptions in v1. x402 stays isolated to agent-driven overages and future prepaid products.</span>
              </div>
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Quota visibility</div>
                <h3 className="panel-card__title">Current hosted limits</h3>
                <p className="panel-card__body">Free-tier exhaustion drives the upgrade CTA for administrators and later x402 handling for agents.</p>
              </div>
            </div>

            <div className="quota-grid quota-grid--single">
              <QuotaMeter
                helper={`Resets ${new Date(summary.quota.secret_requests.reset_at * 1000).toLocaleString()}.`}
                label="Secret requests"
                limit={summary.quota.secret_requests.limit}
                tone={summary.quota.secret_requests.used >= summary.quota.secret_requests.limit ? "danger" : "default"}
                used={summary.quota.secret_requests.used}
              />
              <QuotaMeter
                helper="Active enrolled agents for this workspace."
                label="Agents"
                limit={summary.quota.agents.limit}
                tone={summary.quota.agents.used >= summary.quota.agents.limit ? "warning" : "default"}
                used={summary.quota.agents.used}
              />
              <QuotaMeter
                helper="Active admins, operators, and viewers."
                label="Members"
                limit={summary.quota.members.limit}
                tone={summary.quota.members.used >= summary.quota.members.limit ? "warning" : "default"}
                used={summary.quota.members.used}
              />
            </div>

            <div className="turnstile-placeholder turnstile-placeholder--info">
              <Coins size={18} />
              <div>
                <strong>Agent payments next</strong>
                <span>x402 overages will use settle-before-release semantics and their own USD-cent ledger instead of mutating the recurring billing record.</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
