import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import {
  BillingServiceError,
  constructStripeWebhookEvent,
  createCheckoutSession,
  createStripeClient,
  getBillingRecord,
  handleStripeWebhook,
  type BillingRecord,
  type StripeClientLike
} from "../services/billing.js";
import { ensureWorkspaceOwnerVerified, UserServiceError } from "../services/user.js";

export interface BillingRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  stripeClient?: StripeClientLike;
  successUrl?: string;
  cancelUrl?: string;
}

function toBillingResponse(billing: BillingRecord) {
  return {
    workspace_id: billing.workspaceId,
    workspace_slug: billing.workspaceSlug,
    tier: billing.tier,
    status: billing.status,
    stripe_customer_id: billing.stripeCustomerId,
    stripe_subscription_id: billing.stripeSubscriptionId,
    subscription_status: billing.subscriptionStatus
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
    ?? process.env.SPS_STRIPE_SUCCESS_URL?.trim()
    ?? `${process.env.SPS_UI_BASE_URL?.trim() || process.env.SPS_BASE_URL?.trim() || "http://localhost:5173"}/billing/success`;
}

function resolveCancelUrl(opts: BillingRoutesOptions): string {
  return opts.cancelUrl
    ?? process.env.SPS_STRIPE_CANCEL_URL?.trim()
    ?? `${process.env.SPS_UI_BASE_URL?.trim() || process.env.SPS_BASE_URL?.trim() || "http://localhost:5173"}/billing/cancel`;
}

function resolvePriceId(): string {
  const priceId = process.env.SPS_STRIPE_STANDARD_PRICE_ID?.trim();
  if (!priceId) {
    throw new BillingServiceError(500, "stripe_price_not_configured", "Stripe standard price id is not configured");
  }

  return priceId;
}

export async function registerBillingRoutes(app: FastifyInstance, opts: BillingRoutesOptions): Promise<void> {
  const stripe = opts.stripeClient ?? createStripeClient();

  app.post("/billing/checkout", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    try {
      await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
      const checkout = await createCheckoutSession(opts.db, stripe, {
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

  await app.register(async (webhookApp) => {
    webhookApp.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      done(null, body);
    });

    webhookApp.post<{ Body: string }>("/stripe", async (req, reply) => {
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || !signature.trim()) {
        return reply.code(400).send({ error: "Missing Stripe signature", code: "missing_stripe_signature" });
      }

      try {
        const event = constructStripeWebhookEvent(stripe, req.body, signature);
        const billing = await handleStripeWebhook(opts.db, event);
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
