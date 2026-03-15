import { apiRequest } from "./client.js";

export interface DashboardSummaryResponse {
  workspace: {
    id: string;
    slug: string;
    display_name: string;
    tier: string;
    status: string;
  };
  billing: {
    workspace_id: string;
    workspace_slug: string;
    tier: string;
    status: string;
    billing_provider: string | null;
    provider_customer_id: string | null;
    provider_subscription_id: string | null;
    subscription_status: string;
  };
  counts: {
    active_agents: number;
    active_members: number;
  };
  quota: {
    secret_requests: {
      used: number;
      limit: number;
      reset_at: number;
    };
    agents: {
      used: number;
      limit: number;
    };
    members: {
      used: number;
      limit: number;
    };
    a2a_exchange_available: boolean;
  };
}

export interface BillingCheckoutResponse {
  checkout_url: string;
  session_id: string;
}

export interface BillingPortalResponse {
  portal_url: string;
}

export interface BillingAllowance {
  agent_id: string;
  display_name: string | null;
  status: string | null;
  monthly_budget_cents: number;
  current_spend_cents: number;
  remaining_budget_cents: number;
  budget_reset_at: string;
  updated_at: string;
}

export interface BillingAllowanceListResponse {
  allowances: BillingAllowance[];
}

export interface X402Transaction {
  id: string;
  workspace_id: string;
  agent_id: string;
  payment_id: string;
  quoted_amount_cents: number;
  quoted_currency: string;
  quoted_asset_symbol: string;
  quoted_asset_amount: string;
  scheme: string;
  network_id: string;
  resource_type: string;
  resource_id: string | null;
  tx_hash: string | null;
  status: string;
  quote_expires_at: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface X402TransactionListResponse {
  transactions: X402Transaction[];
  next_cursor: string | null;
}

export function getDashboardSummary(): Promise<DashboardSummaryResponse> {
  return apiRequest<DashboardSummaryResponse>("/api/v2/dashboard/summary");
}

export function createBillingCheckoutSession(): Promise<BillingCheckoutResponse> {
  return apiRequest<BillingCheckoutResponse>("/api/v2/billing/checkout", {
    method: "POST"
  });
}

export function createBillingPortalSession(): Promise<BillingPortalResponse> {
  return apiRequest<BillingPortalResponse>("/api/v2/billing/portal", {
    method: "POST"
  });
}

export function listBillingAllowances(): Promise<BillingAllowanceListResponse> {
  return apiRequest<BillingAllowanceListResponse>("/api/v2/billing/allowances");
}

export function upsertBillingAllowance(input: {
  agent_id: string;
  monthly_budget_cents: number;
}): Promise<{ allowance: BillingAllowance }> {
  return apiRequest<{ allowance: BillingAllowance }>("/api/v2/billing/allowances", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listX402Transactions(): Promise<X402TransactionListResponse> {
  return apiRequest<X402TransactionListResponse>("/api/v2/billing/x402/transactions");
}
