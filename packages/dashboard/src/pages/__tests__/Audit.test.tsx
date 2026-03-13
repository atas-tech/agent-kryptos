import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../api/client.js";
import { AuditPage } from "../Audit.js";

vi.mock("../../api/client.js", () => ({
  apiRequest: vi.fn()
}));

const exchangeId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("AuditPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders audit rows, expands metadata, and paginates", async () => {
    (apiRequest as any)
      .mockResolvedValueOnce({
        records: [
          {
            id: "audit-1",
            workspace_id: "workspace-1",
            event_type: "exchange_requested",
            actor_id: "agent:requester",
            actor_type: "agent",
            resource_id: exchangeId,
            metadata: {
              secret_name: "stripe.api_key.prod",
              purpose: "charge-order"
            },
            ip_address: "203.0.113.10",
            created_at: new Date().toISOString()
          }
        ],
        next_cursor: "cursor-2"
      })
      .mockResolvedValueOnce({
        records: [
          {
            id: "audit-2",
            workspace_id: "workspace-1",
            event_type: "member_created",
            actor_id: "user-1",
            actor_type: "user",
            resource_id: "user-2",
            metadata: {
              email: "viewer@example.com"
            },
            ip_address: "203.0.113.11",
            created_at: new Date().toISOString()
          }
        ],
        next_cursor: null
      })
      .mockResolvedValueOnce({
        exchange_id: exchangeId,
        records: [
          {
            id: "timeline-1",
            workspace_id: "workspace-1",
            event_type: "exchange_requested",
            actor_id: "agent:requester",
            actor_type: "agent",
            resource_id: exchangeId,
            metadata: {
              purpose: "charge-order"
            },
            ip_address: null,
            created_at: new Date().toISOString()
          }
        ]
      });

    render(
      <MemoryRouter initialEntries={["/audit"]}>
        <Routes>
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/audit/exchange/:exchangeId" element={<AuditPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Audit log viewer")).toBeInTheDocument();
    expect(screen.getAllByText("exchange_requested")).toHaveLength(2);

    await userEvent.click(screen.getAllByText("exchange_requested")[1]!);
    expect(await screen.findByText("Sanitized metadata")).toBeInTheDocument();
    expect(screen.getByText(/stripe\.api_key\.prod/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(await screen.findAllByText("member_created")).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: /open exchange/i })[0]!);
    expect(await screen.findByText("Exchange lifecycle timeline")).toBeInTheDocument();
  });

  it("renders the exchange drill-down timeline", async () => {
    (apiRequest as any).mockResolvedValue({
      exchange_id: exchangeId,
      records: [
        {
          id: "timeline-1",
          workspace_id: "workspace-1",
          event_type: "exchange_requested",
          actor_id: "agent:requester",
          actor_type: "agent",
          resource_id: exchangeId,
          metadata: {
            purpose: "charge-order"
          },
          ip_address: null,
          created_at: new Date().toISOString()
        },
        {
          id: "timeline-2",
          workspace_id: "workspace-1",
          event_type: "exchange_approved",
          actor_id: "user-1",
          actor_type: "user",
          resource_id: "apr_deadbeefdeadbeefdeadbe",
          metadata: {
            approval_reference: "apr_deadbeefdeadbeefdeadbe"
          },
          ip_address: null,
          created_at: new Date().toISOString()
        }
      ]
    });

    render(
      <MemoryRouter initialEntries={[`/audit/exchange/${exchangeId}`]}>
        <Routes>
          <Route path="/audit/exchange/:exchangeId" element={<AuditPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Exchange lifecycle timeline")).toBeInTheDocument();
    expect(screen.getByText("exchange requested")).toBeInTheDocument();
    expect(screen.getAllByText("exchange approved")).toHaveLength(2);

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(`/api/v2/audit/exchange/${exchangeId}`);
    });
  });
});
