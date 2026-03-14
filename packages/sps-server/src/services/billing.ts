import Stripe from "stripe";
import type { Pool } from "pg";
import type { WorkspaceRecord, WorkspaceTier } from "./workspace.js";

// ---------------------------------------------------------------------------
// Subscription status (shared across all providers)
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | "none"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "trialing";

// ---------------------------------------------------------------------------
// BillingProvider interface — every payment processor must implement this
// ---------------------------------------------------------------------------

export interface CreateCheckoutInput {
  workspaceId: string;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  priceId: string;
  existingCustomerId?: string | null;
  workspaceDisplayName: string;
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
  customerId: string;
  subscriptionId?: string | null;
}

export interface CreatePortalInput {
  customerId: string;
  returnUrl: string;
}

export interface PortalResult {
  url: string;
}

export interface WebhookResult {
  /** null = event ignored, non-null = billing state change to persist */
  billingPatch: {
    tier?: WorkspaceTier;
    customerId?: string | null;
    subscriptionId?: string | null;
    subscriptionStatus?: SubscriptionStatus;
  } | null;
  workspaceId?: string | null;
}

export interface BillingProvider {
  readonly name: string; // e.g. 'stripe', 'x402'

  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutResult>;
  createPortalSession(input: CreatePortalInput): Promise<PortalResult>;
  handleWebhookEvent(payload: string | Buffer, signature: string): Promise<WebhookResult>;
}

export class MockBillingProvider implements BillingProvider {
  readonly name = "stripe";

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutResult> {
    return {
      url: `http://localhost:5173/billing/success?mock_session_id=mock_checkout_${Date.now()}`,
      sessionId: `mock_checkout_${Date.now()}`,
      customerId: input.existingCustomerId ?? `mock_cus_${Date.now()}`,
      subscriptionId: `mock_sub_${Date.now()}`
    };
  }

  async createPortalSession(input: CreatePortalInput): Promise<PortalResult> {
    return {
      url: `http://localhost:5173/billing?mock_portal=1`
    };
  }

  async handleWebhookEvent(_payload: string | Buffer, _signature: string): Promise<WebhookResult> {
    return { billingPatch: null };
  }
}

// ---------------------------------------------------------------------------
// DB row / record types (provider-agnostic)
// ---------------------------------------------------------------------------

interface BillingWorkspaceRow {
  id: string;
  slug: string;
  display_name: string;
  tier: WorkspaceTier;
  status: WorkspaceRecord["status"];
  owner_user_id: string | null;
  billing_provider: string | null;
  billing_provider_customer_id: string | null;
  billing_provider_subscription_id: string | null;
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
  billingProvider: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BillingServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    billingProvider: row.billing_provider,
    providerCustomerId: row.billing_provider_customer_id,
    providerSubscriptionId: row.billing_provider_subscription_id,
    subscriptionStatus: normalizeSubscriptionStatus(row.subscription_status)
  };
}

// ---------------------------------------------------------------------------
// DB queries (generic, shared across all providers)
// ---------------------------------------------------------------------------

const BILLING_WORKSPACE_COLUMNS = `
  id,
  slug,
  display_name,
  tier,
  status,
  owner_user_id,
  billing_provider,
  billing_provider_customer_id,
  billing_provider_subscription_id,
  subscription_status,
  created_at,
  updated_at
`;

async function queryBillingWorkspace(db: Pool, workspaceId: string): Promise<BillingWorkspaceRow | null> {
  const result = await db.query<BillingWorkspaceRow>(
    `
      SELECT ${BILLING_WORKSPACE_COLUMNS}
      FROM workspaces
      WHERE id = $1
      LIMIT 1
    `,
    [workspaceId]
  );

  return result.rows[0] ?? null;
}

export async function queryOwnerEmail(db: Pool, workspaceId: string): Promise<string | null> {
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

export async function updateBillingState(
  db: Pool,
  workspaceId: string,
  patch: {
    tier?: WorkspaceTier;
    billingProvider?: string | null;
    providerCustomerId?: string | null;
    providerSubscriptionId?: string | null;
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
            billing_provider = $3,
            billing_provider_customer_id = $4,
            billing_provider_subscription_id = $5,
            subscription_status = $6,
            updated_at = now()
        WHERE id = $1
        RETURNING ${BILLING_WORKSPACE_COLUMNS}
      `,
      [
        workspaceId,
        patch.tier ?? current.tier,
        patch.billingProvider ?? current.billing_provider,
        patch.providerCustomerId ?? current.billing_provider_customer_id,
        patch.providerSubscriptionId ?? current.billing_provider_subscription_id,
        patch.subscriptionStatus ?? normalizeSubscriptionStatus(current.subscription_status)
      ]
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String((error as { code: unknown }).code) === "23505") {
      throw new BillingServiceError(409, "billing_conflict", "Billing provider reference already belongs to another workspace");
    }
    throw error;
  }

  return toBillingRecord(result.rows[0]);
}

export async function requireWorkspaceForBilling(db: Pool, workspaceId: string): Promise<BillingWorkspaceRow> {
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

async function findWorkspaceByProviderReference(
  db: Pool,
  customerId?: string | null,
  subscriptionId?: string | null
): Promise<BillingWorkspaceRow | null> {
  if (!customerId && !subscriptionId) {
    return null;
  }

  const result = await db.query<BillingWorkspaceRow>(
    `
      SELECT ${BILLING_WORKSPACE_COLUMNS}
      FROM workspaces
      WHERE ($1::text IS NOT NULL AND billing_provider_subscription_id = $1)
         OR ($2::text IS NOT NULL AND billing_provider_customer_id = $2)
      LIMIT 1
    `,
    [subscriptionId ?? null, customerId ?? null]
  );

  return result.rows[0] ?? null;
}

export async function getBillingRecord(db: Pool, workspaceId: string): Promise<BillingRecord | null> {
  const workspace = await queryBillingWorkspace(db, workspaceId);
  return workspace ? toBillingRecord(workspace) : null;
}

// ---------------------------------------------------------------------------
// Stripe-specific types
// ---------------------------------------------------------------------------

export interface StripeClientLike {
  customers: Pick<Stripe.CustomersResource, "create">;
  checkout: {
    sessions: Pick<Stripe.Checkout.SessionsResource, "create">;
  };
  billingPortal: {
    sessions: Pick<Stripe.BillingPortal.SessionsResource, "create">;
  };
  webhooks: Pick<Stripe.Webhooks, "constructEvent">;
}

export function createStripeClient(apiKey = process.env.STRIPE_SECRET_KEY?.trim()): StripeClientLike {
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new BillingServiceError(500, "stripe_not_configured", "Stripe secret key is not configured");
    }

    // In non-production, return a dummy client that only throws if a method is actually called.
    // This prevents the server from crashing during registration if the key is missing.
    return new Proxy({} as StripeClientLike, {
      get() {
        return new Proxy({}, {
          get() {
            return () => {
              throw new BillingServiceError(500, "stripe_not_configured", "Stripe secret key is not configured. Check your .env file.");
            };
          }
        });
      }
    }) as unknown as StripeClientLike;
  }

  return new Stripe(apiKey) as unknown as StripeClientLike;
}

// ---------------------------------------------------------------------------
// StripeBillingProvider — implements BillingProvider for Stripe
// ---------------------------------------------------------------------------

export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe";

  constructor(
    private readonly stripe: StripeClientLike,
    private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  ) {}

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutResult> {
    let customerId = input.existingCustomerId ?? null;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: input.customerEmail ?? undefined,
        metadata: {
          workspace_id: input.workspaceId
        },
        name: input.workspaceDisplayName
      });
      customerId = customer.id;
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      line_items: [{
        price: input.priceId,
        quantity: 1
      }],
      metadata: {
        workspace_id: input.workspaceId
      }
    });

    if (!session.url) {
      throw new BillingServiceError(502, "stripe_checkout_failed", "Stripe checkout URL was not returned");
    }

    return {
      url: session.url,
      sessionId: session.id,
      customerId,
      subscriptionId: typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null
    };
  }

  async createPortalSession(input: CreatePortalInput): Promise<PortalResult> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl
    });

    return { url: session.url };
  }

  handleWebhookEvent(payload: string | Buffer, signature: string): Promise<WebhookResult> {
    if (!this.webhookSecret) {
      throw new BillingServiceError(500, "stripe_webhook_not_configured", "Stripe webhook secret is not configured");
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
    } catch {
      throw new BillingServiceError(400, "invalid_stripe_signature", "Invalid Stripe signature");
    }

    return Promise.resolve(this.processStripeEvent(event));
  }

  private processStripeEvent(event: Stripe.Event): WebhookResult {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const workspaceId = session.metadata?.workspace_id ?? null;
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

        if (!workspaceId) {
          throw new BillingServiceError(400, "missing_workspace_id", "Stripe checkout session metadata is missing workspace_id");
        }

        return {
          workspaceId,
          billingPatch: {
            tier: "standard",
            customerId,
            subscriptionId,
            subscriptionStatus: "active"
          }
        };
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
        const subscription = invoice.parent?.subscription_details?.subscription;
        const subscriptionId = typeof subscription === "string" ? subscription : subscription?.id ?? null;

        return {
          workspaceId: null, // resolved via provider reference lookup
          billingPatch: {
            tier: "standard",
            customerId,
            subscriptionId,
            subscriptionStatus: "active"
          }
        };
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null;

        return {
          workspaceId: null, // resolved via provider reference lookup
          billingPatch: {
            tier: "free",
            customerId,
            subscriptionId: subscription.id,
            subscriptionStatus: "canceled"
          }
        };
      }

      default:
        return { billingPatch: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration: process webhook result against the DB
// ---------------------------------------------------------------------------

export async function processWebhookResult(
  db: Pool,
  providerName: string,
  result: WebhookResult
): Promise<BillingRecord | null> {
  if (!result.billingPatch) {
    return null;
  }

  let workspaceId = result.workspaceId ?? null;

  // If the webhook didn't carry a workspace ID, look it up by provider reference
  if (!workspaceId) {
    const workspace = await findWorkspaceByProviderReference(
      db,
      result.billingPatch.customerId,
      result.billingPatch.subscriptionId
    );
    if (!workspace) {
      return null;
    }
    workspaceId = workspace.id;
  }

  return updateBillingState(db, workspaceId, {
    tier: result.billingPatch.tier,
    billingProvider: providerName,
    providerCustomerId: result.billingPatch.customerId,
    providerSubscriptionId: result.billingPatch.subscriptionId,
    subscriptionStatus: result.billingPatch.subscriptionStatus
  });
}

// ---------------------------------------------------------------------------
// Orchestration: full checkout flow (DB + provider)
// ---------------------------------------------------------------------------

export async function createCheckoutFlow(
  db: Pool,
  provider: BillingProvider,
  input: {
    workspaceId: string;
    userEmail?: string | null;
    successUrl: string;
    cancelUrl: string;
    priceId: string;
  }
): Promise<{ url: string; sessionId: string; billing: BillingRecord }> {
  const workspace = await requireWorkspaceForBilling(db, input.workspaceId);

  const checkout = await provider.createCheckoutSession({
    workspaceId: workspace.id,
    customerEmail: input.userEmail ?? (await queryOwnerEmail(db, workspace.id)),
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    priceId: input.priceId,
    existingCustomerId: workspace.billing_provider_customer_id,
    workspaceDisplayName: workspace.display_name
  });

  const billing = await updateBillingState(db, workspace.id, {
    billingProvider: provider.name,
    providerCustomerId: checkout.customerId
  });

  return {
    url: checkout.url,
    sessionId: checkout.sessionId,
    billing
  };
}
