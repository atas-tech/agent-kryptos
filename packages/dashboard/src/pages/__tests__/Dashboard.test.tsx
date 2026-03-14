import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../../auth/useAuth.js";
import { useDashboardSummary } from "../../hooks/useDashboardSummary.js";
import { DashboardPage } from "../Dashboard.js";

vi.mock("../../auth/useAuth.js", () => ({
  useAuth: vi.fn()
}));

vi.mock("../../hooks/useDashboardSummary.js", () => ({
  useDashboardSummary: vi.fn()
}));

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      workspace: {
        id: "workspace-1",
        slug: "acme",
        display_name: "Acme",
        tier: "free",
        status: "active",
        owner_user_id: "user-1",
        created_at: "2026-03-14T00:00:00.000Z",
        updated_at: "2026-03-14T00:00:00.000Z"
      },
      user: {
        role: "workspace_admin"
      },
      setWorkspaceSummary: vi.fn()
    });
  });

  it("renders live quota, billing, and workspace counts", () => {
    (useDashboardSummary as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: {
        workspace: {
          id: "workspace-1",
          slug: "acme",
          display_name: "Acme",
          tier: "free",
          status: "active"
        },
        billing: {
          workspace_id: "workspace-1",
          workspace_slug: "acme",
          tier: "free",
          status: "active",
          billing_provider: "stripe",
          provider_customer_id: "cus_123",
          provider_subscription_id: null,
          subscription_status: "trialing"
        },
        counts: {
          active_agents: 2,
          active_members: 1
        },
        quota: {
          secret_requests: {
            used: 3,
            limit: 10,
            reset_at: 1_773_619_200
          },
          agents: {
            used: 2,
            limit: 5
          },
          members: {
            used: 1,
            limit: 3
          },
          a2a_exchange_available: false
        }
      },
      loading: false,
      error: null,
      refresh: vi.fn()
    });

    render(<DashboardPage />);

    expect(screen.getByText("Workspace command overview")).toBeInTheDocument();
    expect(screen.getAllByText("trialing")).toHaveLength(2);
    expect(screen.getAllByText("2/5")).toHaveLength(1);
    expect(screen.getAllByText("3/10")).toHaveLength(2);
    expect(screen.getByText("exchange locked")).toBeInTheDocument();
    expect(screen.getByText("cus_123")).toBeInTheDocument();
  });
});
