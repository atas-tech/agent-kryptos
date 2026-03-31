import { BadgeDollarSign, Coins, RefreshCcw, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createBillingCheckoutSession,
  createBillingPortalSession,
  listBillingAllowances,
  listX402Transactions,
  type BillingAllowance,
  type X402Transaction,
  upsertBillingAllowance
} from "../api/dashboard.js";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import { DataTable } from "../components/DataTable.js";
import { EmptyState } from "../components/EmptyState.js";
import { FormField } from "../components/FormField.js";
import { QuotaMeter } from "../components/QuotaMeter.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useDashboardSummary } from "../hooks/useDashboardSummary.js";

interface AgentOption {
  id: string;
  agent_id: string;
  display_name: string | null;
  status: "active" | "revoked" | "deleted";
}

interface AgentsResponse {
  agents: AgentOption[];
  next_cursor: string | null;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatDate(value: string | null): string {
  return value ? dateFormatter.format(new Date(value)) : "";
}

function formatUsdCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

export function BillingPage() {
  const { t } = useTranslation(["billing", "common"]);
  const { workspace, setWorkspaceSummary } = useAuth();
  const { summary, loading, error, refresh } = useDashboardSummary();
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [x402Loading, setX402Loading] = useState(true);
  const [allowances, setAllowances] = useState<BillingAllowance[]>([]);
  const [transactions, setTransactions] = useState<X402Transaction[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [budgetAgentId, setBudgetAgentId] = useState("");
  const [budgetCents, setBudgetCents] = useState("25");
  const [budgetPending, setBudgetPending] = useState(false);

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

  useEffect(() => {
    void loadX402Data();
  }, []);

  useEffect(() => {
    if (!budgetAgentId && agents.length > 0) {
      setBudgetAgentId(agents[0]!.agent_id);
    }
  }, [agents, budgetAgentId]);

  async function loadX402Data(): Promise<void> {
    setX402Loading(true);

    try {
      const [agentPayload, allowancePayload, transactionPayload] = await Promise.all([
        apiRequest<AgentsResponse>("/api/v2/agents?status=active&limit=100"),
        listBillingAllowances(),
        listX402Transactions()
      ]);

      setAgents(agentPayload.agents);
      setAllowances(allowancePayload.allowances);
      setTransactions(transactionPayload.transactions);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : t("billing:errors.x402LoadFailed"));
    } finally {
      setX402Loading(false);
    }
  }

  async function handleCheckout(): Promise<void> {
    setCheckoutPending(true);
    setActionError(null);

    try {
      const payload = await createBillingCheckoutSession();
      window.location.assign(payload.checkout_url);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : t("billing:errors.checkoutFailed"));
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
      setActionError(requestError instanceof Error ? requestError.message : t("billing:errors.portalFailed"));
    } finally {
      setPortalPending(false);
    }
  }

  async function handleBudgetSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBudgetPending(true);
    setActionError(null);

    try {
      const parsedBudget = Number.parseInt(budgetCents, 10);
      if (!budgetAgentId || !Number.isFinite(parsedBudget) || parsedBudget < 0) {
        throw new Error(t("billing:x402.errorBudgetInput"));
      }

      await upsertBillingAllowance({
        agent_id: budgetAgentId,
        monthly_budget_cents: parsedBudget
      });
      await loadX402Data();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : t("billing:errors.allowanceSaveFailed"));
    } finally {
      setBudgetPending(false);
    }
  }

  const isStandard = summary?.workspace.tier === "standard";

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div>
          <div className="section-label">{t("billing:hero.sectionLabel")}</div>
          <h2 className="hero-card__title">{t("billing:hero.title")}</h2>
          <p className="hero-card__body">{t("billing:hero.body")}</p>
        </div>
        <div className="hero-card__actions">
          <button className="ghost-button" disabled={loading || x402Loading} onClick={() => { void refresh(); void loadX402Data(); }} type="button">
            <RefreshCcw size={16} />
            {t("billing:actions.refresh")}
          </button>
          {isStandard ? (
            <button className="primary-button" data-testid="billing-portal-btn" disabled={portalPending || loading} onClick={() => void handlePortal()} type="button">
              <BadgeDollarSign size={16} />
              {portalPending ? t("billing:actions.openingPortal") : t("billing:actions.manageSubscription")}
            </button>
          ) : (
            <button className="primary-button" data-testid="billing-upgrade-btn" disabled={checkoutPending || loading} onClick={() => void handleCheckout()} type="button">
              <BadgeDollarSign size={16} />
              {checkoutPending ? t("billing:actions.startingCheckout") : t("billing:actions.upgrade")}
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
              <div className="section-label">{t("billing:loading.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("billing:loading.title")}</h3>
              <p className="panel-card__body">{t("billing:loading.body")}</p>
            </div>
          </div>
        </div>
      ) : null}

      {summary ? (
        <div className="section-grid">
          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("billing:subscription.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("billing:subscription.title")}</h3>
                <p className="panel-card__body">{t("billing:subscription.body")}</p>
              </div>
              <div className="inline-actions">
                <StatusBadge data-testid="subscription-tier-badge" tone={isStandard ? "success" : "warning"}>
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
                <span>{t("billing:subscription.provider")}</span>
                <strong>{summary.billing.billing_provider ?? t("billing:subscription.notConnected")}</strong>
              </article>
              <article className="metric-panel">
                <span>{t("billing:subscription.customerRef")}</span>
                <strong>{summary.billing.provider_customer_id ?? t("billing:subscription.pendingCheckout")}</strong>
              </article>
              <article className="metric-panel">
                <span>{t("billing:subscription.subscriptionRef")}</span>
                <strong>{summary.billing.provider_subscription_id ?? t("billing:subscription.pendingCheckout")}</strong>
              </article>
            </div>

            <div className="turnstile-placeholder">
              <BadgeDollarSign size={18} />
              <div>
                <strong>{t("billing:subscription.infoTitle")}</strong>
                <span>{t("billing:subscription.infoBody")}</span>
              </div>
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("billing:quota.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("billing:quota.title")}</h3>
                <p className="panel-card__body">{t("billing:quota.body")}</p>
              </div>
            </div>

            <div className="quota-grid quota-grid--single">
              <QuotaMeter
                helper={t("billing:quota.resetAt", {
                  date: new Date(summary.quota.secret_requests.reset_at * 1000).toLocaleString()
                })}
                label={t("billing:quota.secretRequests")}
                limit={summary.quota.secret_requests.limit}
                tone={summary.quota.secret_requests.used >= summary.quota.secret_requests.limit ? "danger" : "default"}
                used={summary.quota.secret_requests.used}
              />
              <QuotaMeter
                helper={t("billing:quota.activeAgentsHelper")}
                label={t("billing:quota.agents")}
                limit={summary.quota.agents.limit}
                tone={summary.quota.agents.used >= summary.quota.agents.limit ? "warning" : "default"}
                used={summary.quota.agents.used}
              />
              <QuotaMeter
                helper={t("billing:quota.activeMembersHelper")}
                label={t("billing:quota.members")}
                limit={summary.quota.members.limit}
                tone={summary.quota.members.used >= summary.quota.members.limit ? "warning" : "default"}
                used={summary.quota.members.used}
              />
              <QuotaMeter
                data-testid="quota-exchange-requests"
                helper={t("billing:quota.exchangeRequestsHelper")}
                label={t("billing:quota.exchangeRequests")}
                limit={summary.quota.exchange_requests.limit}
                tone={summary.quota.exchange_requests.used >= summary.quota.exchange_requests.limit ? "danger" : "default"}
                used={summary.quota.exchange_requests.used}
              />
            </div>

            <div className="turnstile-placeholder turnstile-placeholder--info">
              <Coins size={18} />
              <div>
                <strong>{t("billing:quota.infoTitle")}</strong>
                <span>{t("billing:quota.infoBody")}</span>
              </div>
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("billing:x402.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("billing:x402.title")}</h3>
                <p className="panel-card__body">{t("billing:x402.body")}</p>
              </div>
            </div>

            <form className="form-grid" onSubmit={(event) => void handleBudgetSubmit(event)}>
              <label className="field-stack">
                <span>{t("billing:x402.agentLabel")}</span>
                <select
                  className="dashboard-select"
                  data-testid="billing-agent-select"
                  disabled={budgetPending || agents.length === 0}
                  onChange={(event) => setBudgetAgentId(event.target.value)}
                  value={budgetAgentId}
                >
                  {agents.length === 0 ? <option value="">{t("billing:x402.noActiveAgents")}</option> : null}
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.agent_id}>
                      {agent.display_name ? `${agent.display_name} (${agent.agent_id})` : agent.agent_id}
                    </option>
                  ))}
                </select>
                <small>{t("billing:x402.budgetHintAgent")}</small>
              </label>

              <FormField
                data-testid="billing-budget-input"
                hint={t("billing:x402.budgetHint")}
                icon={<Wallet size={16} />}
                label={t("billing:x402.budgetLabel")}
                min="0"
                onChange={(event) => setBudgetCents(event.target.value)}
                type="number"
                value={budgetCents}
              />

              <div className="inline-actions">
                <button className="primary-button" data-testid="billing-save-allowance" disabled={budgetPending || !budgetAgentId} type="submit">
                  <Wallet size={16} />
                  {budgetPending ? t("billing:x402.savingButton") : t("billing:x402.saveButton")}
                </button>
              </div>
            </form>

            <DataTable
              columns={[
                {
                  key: "agent",
                  header: t("billing:x402.agentLabel"),
                  render: (allowance) => (
                    <div>
                      <div className="record-title">{allowance.agent_id}</div>
                      <div className="record-meta">{allowance.display_name ?? t("common:noDisplayName")}</div>
                    </div>
                  )
                },
                {
                  key: "budget",
                  header: t("billing:x402.columnBudget"),
                  render: (allowance) => formatUsdCents(allowance.monthly_budget_cents)
                },
                {
                  key: "spend",
                  header: t("billing:x402.columnSpend"),
                  render: (allowance) => formatUsdCents(allowance.current_spend_cents)
                },
                {
                  key: "remaining",
                  header: t("billing:x402.columnRemaining"),
                  render: (allowance) => formatUsdCents(allowance.remaining_budget_cents)
                },
                {
                  key: "reset",
                  header: t("billing:x402.columnResets"),
                  render: (allowance) => formatDate(allowance.budget_reset_at) || t("common:pending")
                }
              ]}
              emptyState={<EmptyState body={t("billing:x402.emptyBody")} title={t("billing:x402.emptyTitle")} />}
              loading={x402Loading}
              rowKey={(allowance) => allowance.agent_id}
              rows={allowances}
            />
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("billing:ledger.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("billing:ledger.title")}</h3>
                <p className="panel-card__body">{t("billing:ledger.body")}</p>
              </div>
            </div>

            <DataTable
              columns={[
                {
                  key: "agent",
                  header: t("billing:ledger.columnAgent"),
                  render: (transaction) => (
                    <div>
                      <div className="record-title" data-testid="ledger-agent-id">{transaction.agent_id}</div>
                      <div className="record-meta" data-testid="ledger-payment-id">{transaction.payment_id}</div>
                    </div>
                  )
                },
                {
                  key: "amount",
                  header: t("billing:ledger.columnAmount"),
                  render: (transaction) => `${transaction.quoted_asset_amount} ${transaction.quoted_asset_symbol}`
                },
                {
                  key: "usd",
                  header: t("billing:ledger.columnUsd"),
                  render: (transaction) => formatUsdCents(transaction.quoted_amount_cents)
                },
                {
                  key: "status",
                  header: t("billing:ledger.columnStatus"),
                  render: (transaction) => (
                    <StatusBadge data-testid="ledger-status-badge" tone={transaction.status === "settled" ? "success" : transaction.status === "failed" ? "warning" : "neutral"}>
                      {transaction.status}
                    </StatusBadge>
                  )
                },
                {
                  key: "tx",
                  header: t("billing:ledger.columnTxHash"),
                  render: (transaction) => transaction.tx_hash ?? t("billing:ledger.pendingTx")
                },
                {
                  key: "created",
                  header: t("billing:ledger.columnCreated"),
                  render: (transaction) => formatDate(transaction.created_at) || t("common:pending")
                }
              ]}
              emptyState={<EmptyState body={t("billing:ledger.emptyBody")} title={t("billing:ledger.emptyTitle")} />}
              loading={x402Loading}
              rowKey={(transaction) => transaction.id}
              rows={transactions}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
