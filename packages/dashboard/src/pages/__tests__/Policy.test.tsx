import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkspacePolicy,
  updateWorkspacePolicy,
  validateWorkspacePolicy
} from "../../api/dashboard.js";
import { useAuth } from "../../auth/useAuth.js";
import { PolicyPage } from "../Policy.js";

vi.mock("../../api/dashboard.js", () => ({
  getWorkspacePolicy: vi.fn(),
  validateWorkspacePolicy: vi.fn(),
  updateWorkspacePolicy: vi.fn()
}));

vi.mock("../../auth/useAuth.js", () => ({
  useAuth: vi.fn()
}));

const basePolicy = {
  id: "policy-1",
  workspace_id: "workspace-1",
  version: 3,
  source: "manual" as const,
  secret_registry: [
    {
      secretName: "stripe.api_key.prod",
      classification: "finance",
      description: "Stripe production key"
    }
  ],
  exchange_policy: [
    {
      ruleId: "allow-stripe",
      secretName: "stripe.api_key.prod",
      requesterIds: ["agent:crm-bot"],
      fulfillerIds: ["agent:payment-bot"],
      purposes: ["charge-order"],
      mode: "allow" as const,
      reason: "Primary payments flow",
      sameRing: false
    }
  ],
  updated_by_user_id: "user-1",
  created_at: "2026-03-17T12:00:00.000Z",
  updated_at: "2026-03-18T08:00:00.000Z"
};

const expectedUpdatedRule = {
  ...basePolicy.exchange_policy[0],
  requesterIds: ["agent:crm-bot"],
  fulfillerIds: ["agent:payment-bot"],
  approverIds: [],
  requesterRings: [],
  fulfillerRings: [],
  approverRings: [],
  purposes: ["charge-order"],
  allowedRings: [],
  sameRing: false,
  mode: "allow" as const,
  approvalReference: undefined,
  reason: "Updated payments flow"
};

describe("PolicyPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders policy metadata and current rules", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_admin"
      }
    });
    (getWorkspacePolicy as any).mockResolvedValue({
      policy: basePolicy
    });

    render(<PolicyPage />);

    expect(await screen.findByText("Policy")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("stripe.api_key.prod")).toHaveLength(2);
    expect(screen.getByDisplayValue("finance")).toBeInTheDocument();
    expect(screen.getByDisplayValue("allow-stripe")).toBeInTheDocument();
    expect(screen.getAllByText("manual")).toHaveLength(2);
  });

  it("validates and saves policy edits", async () => {
    (useAuth as any).mockReturnValue({
      user: {
        role: "workspace_admin"
      }
    });
    (getWorkspacePolicy as any).mockResolvedValue({
      policy: basePolicy
    });
    (validateWorkspacePolicy as any).mockResolvedValue({
      valid: true,
      issues: []
    });
    (updateWorkspacePolicy as any).mockResolvedValue({
      policy: {
        ...basePolicy,
        version: 4,
        exchange_policy: [
          {
            ...basePolicy.exchange_policy[0],
            reason: "Updated payments flow"
          }
        ]
      }
    });

    render(<PolicyPage />);

    const user = userEvent.setup();
    const reasonInput = await screen.findByDisplayValue("Primary payments flow");
    await user.clear(reasonInput);
    await user.type(reasonInput, "Updated payments flow");

    await user.click(screen.getByRole("button", { name: /validate/i }));

    await waitFor(() => {
      expect(validateWorkspacePolicy).toHaveBeenCalledWith({
        secret_registry: basePolicy.secret_registry,
        exchange_policy: [expectedUpdatedRule]
      });
    });

    await user.click(screen.getByTestId("save-policy-btn"));

    await waitFor(() => {
      expect(updateWorkspacePolicy).toHaveBeenCalledWith({
        expected_version: 3,
        secret_registry: basePolicy.secret_registry,
        exchange_policy: [expectedUpdatedRule]
      });
    });

    expect(await screen.findByText("Policy saved as version 4.")).toBeInTheDocument();
  });
});
