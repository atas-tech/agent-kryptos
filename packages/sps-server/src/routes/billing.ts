import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { countActiveAgents, getActiveAgent } from "../services/agent.js";
import {
  BillingServiceError,
  createCheckoutFlow,
  getBillingRecord,
  processWebhookResult,
  type BillingProvider,
  type BillingRecord
} from "../services/billing.js";
import { activeAgentLimit, activeMemberLimit, exchangeAllowed, exchangeQuotaIncluded, type QuotaService } from "../services/quota.js";
import { countActiveWorkspaceUsers, ensureWorkspaceOwnerVerified, UserServiceError } from "../services/user.js";
import { getWorkspace } from "../services/workspace.js";
import {
  listAgentAllowances,
  listX402Transactions,
  setAgentAllowance,
  type AgentAllowanceRecord,
  type X402TransactionRecord,
  X402ServiceError
} from "../services/x402.js";

export interface BillingRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  provider: BillingProvider;
  quotaService: QuotaService;
  successUrl?: string;
  cancelUrl?: string;
  portalReturnUrl?: string;
}

function toBillingResponse(billing: BillingRecord) {
  return {
    workspace_id: billing.workspaceId,
    workspace_slug: billing.workspaceSlug,
    tier: billing.tier,
    status: billing.status,
    billing_provider: billing.billingProvider,
    provider_customer_id: billing.providerCustomerId,
    provider_subscription_id: billing.providerSubscriptionId,
    subscription_status: billing.subscriptionStatus
  };
}

function toWorkspaceSummary(workspace: NonNullable<Awaited<ReturnType<typeof getWorkspace>>>) {
  return {
    id: workspace.id,
    slug: workspace.slug,
    display_name: workspace.displayName,
    tier: workspace.tier,
    status: workspace.status
  };
}

async function buildDashboardSummary(db: Pool, quotaService: QuotaService, workspaceId: string) {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace) {
    throw new BillingServiceError(404, "workspace_not_found", "Workspace not found");
  }

  const [billing, activeAgents, activeMembers, secretRequestQuota, exchangeRequestQuota] = await Promise.all([
    getBillingRecord(db, workspaceId),
    countActiveAgents(db, workspaceId),
    countActiveWorkspaceUsers(db, workspaceId),
    quotaService.getDailyQuotaUsage(workspaceId, "secret_request", workspace.tier),
    db.query<{ free_exchange_used: number }>(`
      SELECT free_exchange_used FROM workspace_exchange_usage
      WHERE workspace_id = $1 AND usage_month = date_trunc('month', now())
    `, [workspaceId])
  ]);

  const exchangeUsed = exchangeRequestQuota.rows[0]?.free_exchange_used ?? 0;

  if (!billing) {
    throw new BillingServiceError(404, "workspace_not_found", "Workspace not found");
  }

  return {
    workspace: toWorkspaceSummary(workspace),
    billing: toBillingResponse(billing),
    counts: {
      active_agents: activeAgents,
      active_members: activeMembers
    },
    quota: {
      secret_requests: {
        used: secretRequestQuota.used,
        limit: secretRequestQuota.limit,
        reset_at: secretRequestQuota.resetAt
      },
      agents: {
        used: activeAgents,
        limit: activeAgentLimit(workspace.tier)
      },
      members: {
        used: activeMembers,
        limit: activeMemberLimit(workspace.tier)
      },
      exchange_requests: {
        used: exchangeUsed,
        limit: 10,
        reset_at: Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime() / 1000)
      },
      a2a_exchange_available: exchangeQuotaIncluded(workspace.tier)
    }
  };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof BillingServiceError || error instanceof UserServiceError || error instanceof X402ServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  throw error;
}

function toAllowanceResponse(record: AgentAllowanceRecord) {
  return {
    agent_id: record.agentId,
    display_name: record.displayName,
    status: record.status,
    monthly_budget_cents: record.monthlyBudgetCents,
    current_spend_cents: record.currentSpendCents,
    remaining_budget_cents: record.remainingBudgetCents,
    budget_reset_at: record.budgetResetAt.toISOString(),
    updated_at: record.updatedAt.toISOString()
  };
}

function toTransactionResponse(record: X402TransactionRecord) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    agent_id: record.agentId,
    payment_id: record.paymentId,
    quoted_amount_cents: record.quotedAmountCents,
    quoted_currency: record.quotedCurrency,
    quoted_asset_symbol: record.quotedAssetSymbol,
    quoted_asset_amount: record.quotedAssetAmount,
    scheme: record.scheme,
    network_id: record.networkId,
    resource_type: record.resourceType,
    resource_id: record.resourceId,
    tx_hash: record.txHash,
    status: record.status,
    quote_expires_at: record.quoteExpiresAt?.toISOString() ?? null,
    settled_at: record.settledAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString()
  };
}

function resolveSuccessUrl(opts: BillingRoutesOptions): string {
  return opts.successUrl
    ?? process.env.SPS_BILLING_SUCCESS_URL?.trim()
    ?? process.env.SPS_STRIPE_SUCCESS_URL?.trim()
    ?? `${process.env.SPS_UI_BASE_URL?.trim() || process.env.SPS_BASE_URL?.trim() || "http://localhost:5173"}/billing/success`;
}

function resolveCancelUrl(opts: BillingRoutesOptions): string {
  return opts.cancelUrl
    ?? process.env.SPS_BILLING_CANCEL_URL?.trim()
    ?? process.env.SPS_STRIPE_CANCEL_URL?.trim()
    ?? `${process.env.SPS_UI_BASE_URL?.trim() || process.env.SPS_BASE_URL?.trim() || "http://localhost:5173"}/billing/cancel`;
}

function resolvePortalReturnUrl(opts: BillingRoutesOptions): string {
  return opts.portalReturnUrl
    ?? process.env.BILLING_PORTAL_RETURN_URL?.trim()
    ?? `${process.env.SPS_UI_BASE_URL?.trim() || process.env.SPS_BASE_URL?.trim() || "http://localhost:5173"}/billing`;
}

function resolvePriceId(): string {
  const priceId = process.env.SPS_STRIPE_STANDARD_PRICE_ID?.trim();
  if (!priceId) {
    throw new BillingServiceError(500, "stripe_price_not_configured", "Stripe standard price id is not configured");
  }

  return priceId;
}

export async function registerBillingRoutes(app: FastifyInstance, opts: BillingRoutesOptions): Promise<void> {
  const { provider } = opts;

  // -----------------------------------------------------------------------
  // POST /billing/checkout — create a checkout session via active provider
  // -----------------------------------------------------------------------
  app.post("/billing/checkout", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
      const checkout = await createCheckoutFlow(opts.db, provider, {
        workspaceId: user.workspaceId,
        userEmail: user.email ?? null,
        successUrl: resolveSuccessUrl(opts),
        cancelUrl: resolveCancelUrl(opts),
        priceId: resolvePriceId()
      });

      return reply.send({
        checkout_url: checkout.url,
        session_id: checkout.sessionId,
        billing: toBillingResponse(checkout.billing)
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // -----------------------------------------------------------------------
  // POST /billing/portal — create a billing portal session
  // -----------------------------------------------------------------------
  app.post("/billing/portal", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      const billing = await getBillingRecord(opts.db, user.workspaceId);
      if (!billing) {
        return reply.code(404).send({ error: "Workspace not found", code: "workspace_not_found" });
      }

      if (!billing.providerCustomerId) {
        return reply.code(400).send({
          error: "No billing subscription found. Please subscribe first.",
          code: "no_billing_customer"
        });
      }

      if (billing.billingProvider && billing.billingProvider !== provider.name) {
        return reply.code(409).send({
          error: "Workspace billing is managed by a different provider",
          code: "billing_provider_mismatch"
        });
      }

      const portal = await provider.createPortalSession({
        customerId: billing.providerCustomerId,
        returnUrl: resolvePortalReturnUrl(opts)
      });

      return reply.send({ portal_url: portal.url });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // -----------------------------------------------------------------------
  // GET /billing — read current billing record
  // -----------------------------------------------------------------------
  app.get("/billing", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    const billing = await getBillingRecord(opts.db, user.workspaceId);
    if (!billing) {
      return reply.code(404).send({ error: "Workspace not found", code: "workspace_not_found" });
    }

    return reply.send({ billing: toBillingResponse(billing) });
  });

  app.get("/dashboard/summary", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      const summary = await buildDashboardSummary(opts.db, opts.quotaService, user.workspaceId);
      return reply.send(summary);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{
    Body: { agent_id: string; monthly_budget_cents: number };
  }>("/billing/allowances", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agent_id", "monthly_budget_cents"],
        properties: {
          agent_id: { type: "string", minLength: 1, maxLength: 160 },
          monthly_budget_cents: { type: "integer", minimum: 0 }
        }
      }
    }
  }, async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      const agentId = req.body.agent_id.trim();
      if (!agentId) {
        return reply.code(400).send({ error: "agent_id must not be blank", code: "invalid_agent_id" });
      }

      await getActiveAgent(opts.db, user.workspaceId, agentId);
      const allowance = await setAgentAllowance(opts.db, user.workspaceId, agentId, req.body.monthly_budget_cents);
      return reply.code(201).send({ allowance: toAllowanceResponse(allowance) });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get("/billing/allowances", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      const allowances = await listAgentAllowances(opts.db, user.workspaceId);
      return reply.send({ allowances: allowances.map(toAllowanceResponse) });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{
    Querystring: { cursor?: string; limit?: number; agent_id?: string };
  }>("/billing/x402/transactions", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      const page = await listX402Transactions(opts.db, user.workspaceId, {
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit: typeof req.query.limit === "number" ? req.query.limit : undefined,
        agentId: typeof req.query.agent_id === "string" && req.query.agent_id.trim() ? req.query.agent_id.trim() : undefined
      });
      return reply.send({
        transactions: page.transactions.map(toTransactionResponse),
        next_cursor: page.nextCursor
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // -----------------------------------------------------------------------
  // Webhook sub-routes (provider-specific paths, e.g. /webhook/stripe)
  // -----------------------------------------------------------------------
  await app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });

    webhookApp.post<{ Body: string }>(`/${provider.name}`, async (req, reply) => {
      const signature = req.headers[`${provider.name}-signature`] ?? req.headers["x-webhook-signature"];
      if (typeof signature !== "string" || !signature.trim()) {
        return reply.code(400).send({ error: `Missing ${provider.name} webhook signature`, code: "missing_webhook_signature" });
      }

      try {
        const result = await provider.handleWebhookEvent(req.body, signature);
        const billing = await processWebhookResult(opts.db, provider.name, result);
        return reply.send({
          received: true,
          billing: billing ? toBillingResponse(billing) : null
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    });
  }, { prefix: "/webhook" });
}
