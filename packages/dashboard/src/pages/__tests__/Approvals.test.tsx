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

describe("ApprovalsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps viewers read-only while still rendering approval cards", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_viewer"
      }
    });
    (apiRequest as any).mockResolvedValue({
      records: [approvalRequestedRecord()],
      next_cursor: null
    });

    render(<ApprovalsPage />);

    expect(await screen.findByText("Approvals inbox")).toBeInTheDocument();
    expect(screen.getByText("stripe.api_key.prod")).toBeInTheDocument();
    expect(screen.getByText(/viewer access is read-only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deny/i })).toBeDisabled();
  });

  it("lets admins approve pending requests from the inbox", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_admin"
      }
    });
    (apiRequest as any)
      .mockResolvedValueOnce({
        records: [approvalRequestedRecord()],
        next_cursor: null
      })
      .mockResolvedValueOnce({
        approval_reference: "apr_deadbeefdeadbeefdeadbe",
        status: "approved"
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
});
