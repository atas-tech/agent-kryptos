import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { countActiveAgents } from "../services/agent.js";
import {
  BillingServiceError,
  createCheckoutFlow,
  getBillingRecord,
  processWebhookResult,
  type BillingProvider,
  type BillingRecord
} from "../services/billing.js";
import { activeAgentLimit, activeMemberLimit, exchangeAllowed, type QuotaService } from "../services/quota.js";
import { countActiveWorkspaceUsers, ensureWorkspaceOwnerVerified, UserServiceError } from "../services/user.js";
import { getWorkspace } from "../services/workspace.js";

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

  const [billing, activeAgents, activeMembers, secretRequestQuota] = await Promise.all([
    getBillingRecord(db, workspaceId),
    countActiveAgents(db, workspaceId),
    countActiveWorkspaceUsers(db, workspaceId),
    quotaService.getDailyQuotaUsage(workspaceId, "secret_request", workspace.tier)
  ]);

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
      a2a_exchange_available: exchangeAllowed(workspace.tier)
    }
  };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof BillingServiceError || error instanceof UserServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  throw error;
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
