import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAnalyticsActiveAgents,
  getAnalyticsExchangeMetrics,
  getAnalyticsRequestVolume
} from "../../api/dashboard.js";
import { AnalyticsPage } from "../Analytics.js";

vi.mock("../../api/dashboard.js", () => ({
  getAnalyticsRequestVolume: vi.fn(),
  getAnalyticsExchangeMetrics: vi.fn(),
  getAnalyticsActiveAgents: vi.fn()
}));

describe("AnalyticsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (getAnalyticsRequestVolume as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      days: 30,
      series: [
        { date: "2026-03-25", count: 2 },
        { date: "2026-03-26", count: 3 },
        { date: "2026-03-27", count: 5 }
      ]
    });
    (getAnalyticsExchangeMetrics as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      days: 30,
      series: [
        { date: "2026-03-25", successful: 1, failed_expired: 0, denied: 1 },
        { date: "2026-03-26", successful: 2, failed_expired: 1, denied: 0 },
        { date: "2026-03-27", successful: 3, failed_expired: 1, denied: 1 }
      ]
    });
    (getAnalyticsActiveAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      hours: 24,
      active_agents: 4
    });
  });

  it("renders audit-backed charts and active agent summary", async () => {
    render(<AnalyticsPage />);

    expect(await screen.findByText("Workspace analytics")).toBeInTheDocument();
    expect(await screen.findByText("10")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Daily secret requests")).toBeInTheDocument();
    expect(screen.getByText("Successful, failed, and denied flows")).toBeInTheDocument();
    expect(screen.getByText(/4 distinct agents minted tokens/i)).toBeInTheDocument();
  });

  it("reloads analytics when the operator changes the window", async () => {
    render(<AnalyticsPage />);

    await screen.findByText("Workspace analytics");
    await userEvent.selectOptions(screen.getByLabelText("Analytics window"), "7");
    await userEvent.selectOptions(screen.getByLabelText("Active agent window"), "72");

    expect(getAnalyticsRequestVolume).toHaveBeenLastCalledWith(7);
    expect(getAnalyticsExchangeMetrics).toHaveBeenLastCalledWith(7);
    expect(getAnalyticsActiveAgents).toHaveBeenLastCalledWith(72);
  });
});
