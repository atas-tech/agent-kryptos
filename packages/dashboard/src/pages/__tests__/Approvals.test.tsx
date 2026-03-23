import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../api/client.js";
import { useAuth } from "../../auth/useAuth.js";
import { ApprovalsPage } from "../Approvals.js";

vi.mock("../../api/client.js", () => ({
  apiRequest: vi.fn()
}));

vi.mock("../../auth/useAuth.js", () => ({
  useAuth: vi.fn()
}));

function approvalRequestedRecord() {
  return {
    id: "audit-approval-1",
    event_type: "exchange_approval_requested",
    actor_id: "agent:requester",
    actor_type: "agent",
    resource_id: "apr_deadbeefdeadbeefdeadbe",
    metadata: {
      requester_id: "agent:requester",
      fulfilled_by: "agent:fulfiller",
      secret_name: "stripe.api_key.prod",
      purpose: "charge-order",
      policy_rule_id: "finance-to-ops-approval"
    },
    created_at: new Date().toISOString()
  };
}

function guestIntentRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "intent-1",
    actor_type: "guest_agent",
    approval_status: "pending",
    approval_reference: "gapr_guest_1",
    requester_label: "external-agent",
    purpose: "guest handoff",
    resolved_secret_name: "restricted.secret",
    allowed_fulfiller_id: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides
  };
}

describe("ApprovalsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps viewers read-only while distinguishing guest approvals from agent approvals", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_viewer"
      }
    });
    (apiRequest as any).mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v2/audit?")) {
        return {
          records: [approvalRequestedRecord()],
          next_cursor: null
        };
      }

      if (path.startsWith("/api/v2/public/intents/admin?")) {
        return {
          intents: [guestIntentRecord()]
        };
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(<ApprovalsPage />);

    expect(await screen.findByText("Approvals inbox")).toBeInTheDocument();
    expect(screen.getByText("stripe.api_key.prod")).toBeInTheDocument();
    expect(screen.getByText("restricted.secret")).toBeInTheDocument();
    expect(screen.getByText(/viewer access is read-only/i)).toBeInTheDocument();
    expect(screen.getByText("Pending guest approval")).toBeInTheDocument();
    expect(screen.getByText("Pending agent approval")).toBeInTheDocument();
    expect(screen.getByText("Guest requester")).toBeInTheDocument();

    const approveButtons = screen.getAllByRole("button", { name: /approve/i });
    const denyButtons = screen.getAllByRole("button", { name: /deny/i });
    expect(approveButtons).toHaveLength(2);
    expect(denyButtons).toHaveLength(2);
    for (const button of [...approveButtons, ...denyButtons]) {
      expect(button).toBeDisabled();
    }
  });

  it("lets admins approve pending exchange requests from the inbox", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_admin"
      }
    });
    (apiRequest as any).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/v2/audit?")) {
        return {
          records: [approvalRequestedRecord()],
          next_cursor: null
        };
      }

      if (path.startsWith("/api/v2/public/intents/admin?")) {
        return {
          intents: []
        };
      }

      if (path === "/api/v2/secret/exchange/admin/approval/apr_deadbeefdeadbeefdeadbe/approve" && init?.method === "POST") {
        return {
          approval_reference: "apr_deadbeefdeadbeefdeadbe",
          status: "approved"
        };
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(<ApprovalsPage />);

    expect(await screen.findByText("stripe.api_key.prod")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        "/api/v2/secret/exchange/admin/approval/apr_deadbeefdeadbeefdeadbe/approve",
        { method: "POST" }
      );
    });
    expect(await screen.findByText(/approved apr_deadbeefdeadbeefdeadbe/i)).toBeInTheDocument();
    expect(screen.queryByText("stripe.api_key.prod")).not.toBeInTheDocument();
  });

  it("lets admins approve pending guest requests from the inbox", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_admin"
      }
    });
    (apiRequest as any).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/v2/audit?")) {
        return {
          records: [],
          next_cursor: null
        };
      }

      if (path.startsWith("/api/v2/public/intents/admin?")) {
        return {
          intents: [guestIntentRecord()]
        };
      }

      if (path === "/api/v2/public/intents/intent-1/approve" && init?.method === "POST") {
        return {
          intent: {
            id: "intent-1",
            approval_status: "approved"
          }
        };
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(<ApprovalsPage />);

    expect(await screen.findByText("restricted.secret")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("/api/v2/public/intents/intent-1/approve", { method: "POST" });
    });
    expect(await screen.findByText(/approved intent-1/i)).toBeInTheDocument();
    expect(screen.queryByText("restricted.secret")).not.toBeInTheDocument();
  });
});
