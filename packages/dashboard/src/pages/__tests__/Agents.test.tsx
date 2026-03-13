import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "../Agents.js";
import { apiRequest } from "../../api/client.js";

vi.mock("../../api/client.js", () => ({
  apiRequest: vi.fn()
}));

const mockAgents = [
  {
    id: "agent-1",
    agent_id: "prod-bot",
    display_name: "Production Bot",
    status: "active",
    created_at: new Date().toISOString(),
    revoked_at: null,
  }
];

describe("AgentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders agents and allows enrollment", async () => {
    (apiRequest as any).mockImplementation((url: string) => {
      if (url.includes("/api/v2/agents")) {
        return Promise.resolve({
          agents: mockAgents,
          next_cursor: null
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<AgentsPage />);

    expect(await screen.findByText("prod-bot")).toBeInTheDocument();
    expect(screen.getByText("Production Bot")).toBeInTheDocument();

    // Open Enroll Modal
    fireEvent.click(screen.getByRole("button", { name: /Enroll agent/i }));
    expect(screen.getByText("Enroll a new agent")).toBeInTheDocument();
  });

  it("reveals bootstrap key upon successful enrollment", async () => {
    (apiRequest as any)
      .mockResolvedValueOnce({ agents: [], next_cursor: null }) // loadAgents
      .mockResolvedValueOnce({
        agent: { agent_id: "new-agent", status: "active" },
        bootstrap_api_key: "ak_new_123"
      }) // handleEnroll
      .mockResolvedValueOnce({ agents: [], next_cursor: null }); // loadAgents after enroll

    render(<AgentsPage />);

    fireEvent.click(screen.getByRole("button", { name: /Enroll agent/i }));
    fireEvent.change(screen.getByLabelText("Agent ID"), { target: { value: "new-agent" } });
    fireEvent.submit(screen.getByRole("button", { name: /Create bootstrap key/i }));

    expect(await screen.findByText("ak_new_123")).toBeInTheDocument();
    expect(screen.getByText(/One-time bootstrap reveal/i)).toBeInTheDocument();
  });
});
