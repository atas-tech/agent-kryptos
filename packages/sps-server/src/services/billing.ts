import Stripe from "stripe";
import type { Pool } from "pg";
import type { WorkspaceRecord, WorkspaceTier } from "./workspace.js";

export type SubscriptionStatus =
  | "none"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "trialing";

interface BillingWorkspaceRow {
  id: string;
  slug: string;
  display_name: string;
  tier: WorkspaceTier;
  status: WorkspaceRecord["status"];
  owner_user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  created_at: Date;
  updated_at: Date;
}

interface UserContactRow {
  email: string;
}

export interface BillingRecord {
  workspaceId: string;
  workspaceSlug: string;
  tier: WorkspaceTier;
  status: WorkspaceRecord["status"];
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
}

export interface StripeClientLike {
  customers: Pick<Stripe.CustomersResource, "create">;
  checkout: {
    sessions: Pick<Stripe.Checkout.SessionsResource, "create">;
  };
  webhooks: Pick<Stripe.Webhooks, "constructEvent">;
}

export interface CreateCheckoutSessionInput {
  workspaceId: string;
  userEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  priceId: string;
}

export class BillingServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeSubscriptionStatus(value: string | null | undefined): SubscriptionStatus {
  switch (value) {
    case "active":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "trialing":
      return value;
    default:
      return "none";
  }
}

function toBillingRecord(row: BillingWorkspaceRow): BillingRecord {
  return {
    workspaceId: row.id,
    workspaceSlug: row.slug,
    tier: row.tier,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: normalizeSubscriptionStatus(row.subscription_status)
  };
}

async function queryBillingWorkspace(db: Pool, workspaceId: string): Promise<BillingWorkspaceRow | null> {
  const result = await db.query<BillingWorkspaceRow>(
    `
      SELECT
        id,
        slug,
        display_name,
        tier,
        status,
        owner_user_id,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_status,
        created_at,
        updated_at
      FROM workspaces
      WHERE id = $1
      LIMIT 1
    `,
    [workspaceId]
  );

  return result.rows[0] ?? null;
}

async function queryOwnerEmail(db: Pool, workspaceId: string): Promise<string | null> {
  const result = await db.query<UserContactRow>(
    `
      SELECT u.email
      FROM workspaces w
      INNER JOIN users u ON u.id = w.owner_user_id
      WHERE w.id = $1
      LIMIT 1
    `,
    [workspaceId]
  );

  return result.rows[0]?.email ?? null;
}

async function updateBillingState(
  db: Pool,
  workspaceId: string,
  patch: {
    tier?: WorkspaceTier;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: SubscriptionStatus;
  }
): Promise<BillingRecord> {
  const current = await queryBillingWorkspace(db, workspaceId);
  if (!current) {
    throw new BillingServiceError(404, "workspace_not_found", "Workspace not found");
  }

  let result;
  try {
    result = await db.query<BillingWorkspaceRow>(
      `
        UPDATE workspaces
        SET tier = $2,
            stripe_customer_id = $3,
            stripe_subscription_id = $4,
            subscription_status = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING
          id,
          slug,
          display_name,
          tier,
          status,
          owner_user_id,
          stripe_customer_id,
          stripe_subscription_id,
          subscription_status,
          created_at,
          updated_at
      `,
      [
        workspaceId,
        patch.tier ?? current.tier,
        patch.stripeCustomerId ?? current.stripe_customer_id,
        patch.stripeSubscriptionId ?? current.stripe_subscription_id,
        patch.subscriptionStatus ?? normalizeSubscriptionStatus(current.subscription_status)
      ]
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String((error as { code: unknown }).code) === "23505") {
      throw new BillingServiceError(409, "billing_conflict", "Stripe billing reference already belongs to another workspace");
    }
    throw error;
  }

  return toBillingRecord(result.rows[0]);
}

async function requireWorkspaceForBilling(db: Pool, workspaceId: string): Promise<BillingWorkspaceRow> {
  const workspace = await queryBillingWorkspace(db, workspaceId);
  if (!workspace) {
    throw new BillingServiceError(404, "workspace_not_found", "Workspace not found");
  }

  if (workspace.status === "suspended") {
    throw new BillingServiceError(403, "workspace_suspended", "Workspace is suspended");
  }

  if (workspace.status === "deleted") {
    throw new BillingServiceError(403, "workspace_deleted", "Workspace is deleted");
  }

  return workspace;
}

async function findWorkspaceByStripeReference(
  db: Pool,
  customerId?: string | null,
  subscriptionId?: string | null
): Promise<BillingWorkspaceRow | null> {
  if (!customerId && !subscriptionId) {
    return null;
  }

  const result = await db.query<BillingWorkspaceRow>(
    `
      SELECT
        id,
        slug,
        display_name,
        tier,
        status,
        owner_user_id,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_status,
        created_at,
        updated_at
      FROM workspaces
      WHERE ($1::text IS NOT NULL AND stripe_subscription_id = $1)
         OR ($2::text IS NOT NULL AND stripe_customer_id = $2)
      LIMIT 1
    `,
    [subscriptionId ?? null, customerId ?? null]
  );

  return result.rows[0] ?? null;
}

export function createStripeClient(apiKey = process.env.STRIPE_SECRET_KEY?.trim()): StripeClientLike {
  if (!apiKey) {
    throw new BillingServiceError(500, "stripe_not_configured", "Stripe secret key is not configured");
  }

  return new Stripe(apiKey);
}

export async function getBillingRecord(db: Pool, workspaceId: string): Promise<BillingRecord | null> {
  const workspace = await queryBillingWorkspace(db, workspaceId);
  return workspace ? toBillingRecord(workspace) : null;
}

export async function createCheckoutSession(
  db: Pool,
  stripe: StripeClientLike,
  input: CreateCheckoutSessionInput
): Promise<{ url: string; sessionId: string; billing: BillingRecord }> {
  const workspace = await requireWorkspaceForBilling(db, input.workspaceId);
  let customerId = workspace.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: input.userEmail ?? (await queryOwnerEmail(db, input.workspaceId)) ?? undefined,
      metadata: {
        workspace_id: workspace.id
      },
      name: workspace.display_name
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    line_items: [{
      price: input.priceId,
      quantity: 1
    }],
    metadata: {
      workspace_id: workspace.id
    }
  });

  if (!session.url) {
    throw new BillingServiceError(502, "stripe_checkout_failed", "Stripe checkout URL was not returned");
  }

  const billing = await updateBillingState(db, workspace.id, {
    stripeCustomerId: customerId
  });

  return {
    url: session.url,
    sessionId: session.id,
    billing
  };
}

export async function handleStripeWebhook(db: Pool, event: Stripe.Event): Promise<BillingRecord | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const workspaceId = session.metadata?.workspace_id;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

      if (!workspaceId) {
        throw new BillingServiceError(400, "missing_workspace_id", "Stripe checkout session metadata is missing workspace_id");
      }

      return updateBillingState(db, workspaceId, {
        tier: "standard",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active"
      });
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
      const subscription = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subscription === "string" ? subscription : subscription?.id ?? null;
      const workspace = await findWorkspaceByStripeReference(db, customerId, subscriptionId);
      if (!workspace) {
        return null;
      }

      return updateBillingState(db, workspace.id, {
        tier: "standard",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active"
      });
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null;
      const workspace = await findWorkspaceByStripeReference(db, customerId, subscription.id);
      if (!workspace) {
        return null;
      }

      return updateBillingState(db, workspace.id, {
        tier: "free",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: "canceled"
      });
    }

    default:
      return null;
  }
}

export function constructStripeWebhookEvent(
  stripe: StripeClientLike,
  payload: string | Buffer,
  signature: string,
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
): Stripe.Event {
  if (!webhookSecret) {
    throw new BillingServiceError(500, "stripe_webhook_not_configured", "Stripe webhook secret is not configured");
  }

  try {
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    throw new BillingServiceError(400, "invalid_stripe_signature", "Invalid Stripe signature");
  }
}
