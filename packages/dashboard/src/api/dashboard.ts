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
