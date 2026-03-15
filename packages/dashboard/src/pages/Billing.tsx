import { BadgeDollarSign, Coins, RefreshCcw, Wallet } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
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
  if (!value) {
    return "Pending";
  }

  return dateFormatter.format(new Date(value));
}

function formatUsdCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

export function BillingPage() {
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
      setActionError(requestError instanceof Error ? requestError.message : "Unable to load x402 data");
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

  async function handleBudgetSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBudgetPending(true);
    setActionError(null);

    try {
      const parsedBudget = Number.parseInt(budgetCents, 10);
      if (!budgetAgentId || !Number.isFinite(parsedBudget) || parsedBudget < 0) {
        throw new Error("Select an agent and enter a non-negative budget in cents.");
      }

      await upsertBillingAllowance({
        agent_id: budgetAgentId,
        monthly_budget_cents: parsedBudget
      });
      await loadX402Data();
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : "Unable to save x402 allowance");
    } finally {
      setBudgetPending(false);
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
            Manage the recurring workspace subscription here alongside the first x402 controls for agent-paid exchange
            overages.
          </p>
        </div>
        <div className="hero-card__actions">
          <button className="ghost-button" disabled={loading || x402Loading} onClick={() => { void refresh(); void loadX402Data(); }} type="button">
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
                <span>Stripe still manages recurring subscriptions. x402 now covers per-agent overage payments separately.</span>
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
                <strong>Agent payments live</strong>
                <span>x402 overages settle before release and use their own USD-cent ledger instead of mutating the recurring billing record.</span>
              </div>
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">x402 allowances</div>
                <h3 className="panel-card__title">Per-agent monthly budgets</h3>
                <p className="panel-card__body">
                  Free-tier workspaces get 10 monthly exchange requests. After that, enrolled agents need an explicit x402 budget.
                </p>
              </div>
            </div>

            <form className="form-grid" onSubmit={(event) => void handleBudgetSubmit(event)}>
              <label className="field-stack">
                <span>Agent</span>
                <select
                  className="dashboard-select"
                  disabled={budgetPending || agents.length === 0}
                  onChange={(event) => setBudgetAgentId(event.target.value)}
                  value={budgetAgentId}
                >
                  {agents.length === 0 ? <option value="">No active agents</option> : null}
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.agent_id}>
                      {agent.display_name ? `${agent.display_name} (${agent.agent_id})` : agent.agent_id}
                    </option>
                  ))}
                </select>
                <small>Only active enrolled agents can receive an x402 allowance.</small>
              </label>

              <FormField
                hint="Stored in USD cents per UTC calendar month."
                icon={<Wallet size={16} />}
                label="Monthly budget"
                min="0"
                onChange={(event) => setBudgetCents(event.target.value)}
                type="number"
                value={budgetCents}
              />

              <div className="inline-actions">
                <button className="primary-button" disabled={budgetPending || !budgetAgentId} type="submit">
                  <Wallet size={16} />
                  {budgetPending ? "Saving..." : "Save allowance"}
                </button>
              </div>
            </form>

            <DataTable
              columns={[
                {
                  key: "agent",
                  header: "Agent",
                  render: (allowance) => (
                    <div>
                      <div className="record-title">{allowance.agent_id}</div>
                      <div className="record-meta">{allowance.display_name ?? "No display name"}</div>
                    </div>
                  )
                },
                {
                  key: "budget",
                  header: "Budget",
                  render: (allowance) => formatUsdCents(allowance.monthly_budget_cents)
                },
                {
                  key: "spend",
                  header: "Spend",
                  render: (allowance) => formatUsdCents(allowance.current_spend_cents)
                },
                {
                  key: "remaining",
                  header: "Remaining",
                  render: (allowance) => formatUsdCents(allowance.remaining_budget_cents)
                },
                {
                  key: "reset",
                  header: "Resets",
                  render: (allowance) => formatDate(allowance.budget_reset_at)
                }
              ]}
              emptyState={<EmptyState body="Set a monthly budget for an enrolled agent to enable paid overages." title="No allowances yet" />}
              loading={x402Loading}
              rowKey={(allowance) => allowance.agent_id}
              rows={allowances}
            />
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">x402 ledger</div>
                <h3 className="panel-card__title">Recent autonomous payments</h3>
                <p className="panel-card__body">
                  This is the first per-agent payment ledger: quoted spend, settlement status, and chain transaction reference.
                </p>
              </div>
            </div>

            <DataTable
              columns={[
                {
                  key: "agent",
                  header: "Agent",
                  render: (transaction) => (
                    <div>
                      <div className="record-title">{transaction.agent_id}</div>
                      <div className="record-meta">{transaction.payment_id}</div>
                    </div>
                  )
                },
                {
                  key: "amount",
                  header: "Amount",
                  render: (transaction) => `${transaction.quoted_asset_amount} ${transaction.quoted_asset_symbol}`
                },
                {
                  key: "usd",
                  header: "USD",
                  render: (transaction) => formatUsdCents(transaction.quoted_amount_cents)
                },
                {
                  key: "status",
                  header: "Status",
                  render: (transaction) => (
                    <StatusBadge tone={transaction.status === "settled" ? "success" : transaction.status === "failed" ? "warning" : "neutral"}>
                      {transaction.status}
                    </StatusBadge>
                  )
                },
                {
                  key: "tx",
                  header: "Tx hash",
                  render: (transaction) => transaction.tx_hash ?? "Pending"
                },
                {
                  key: "created",
                  header: "Created",
                  render: (transaction) => formatDate(transaction.created_at)
                }
              ]}
              emptyState={<EmptyState body="Paid exchange overages will appear here after the free monthly cap is exhausted." title="No x402 payments yet" />}
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
