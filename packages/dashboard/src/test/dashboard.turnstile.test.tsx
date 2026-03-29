import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security/turnstile.js", () => ({
  turnstileEnabled: () => true,
  turnstileSiteKey: () => "site-key"
}));

vi.mock("../components/TurnstileWidget.js", () => ({
  TurnstileWidget: ({ onTokenChange }: { onTokenChange: (token: string | null) => void }) => (
    <button onClick={() => onTokenChange("turnstile-token")} type="button">
      Solve challenge
    </button>
  )
}));

import { App } from "../App.js";
import { AuthProvider } from "../auth/AuthContext.js";

function renderApp(initialEntries = ["/"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("dashboard turnstile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks login until turnstile is completed and submits the token", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);

      if (url.endsWith("/api/v2/auth/refresh")) {
        return new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 });
      }

      if (url.endsWith("/api/v2/auth/login")) {
        return new Response(
          JSON.stringify({
            access_token: "header.eyJmcGMiOmZhbHNlfQ.signature",
            user: {
              id: "user-1",
              email: "owner@example.com",
              role: "workspace_admin",
              status: "active",
              email_verified: true,
              force_password_change: false,
              workspace_id: "workspace-1",
              created_at: "2026-03-13T00:00:00.000Z",
              updated_at: "2026-03-13T00:00:00.000Z"
            },
            workspace: {
              id: "workspace-1",
              slug: "acme",
              display_name: "Acme",
              tier: "free",
              status: "active",
              owner_user_id: "user-1",
              created_at: "2026-03-13T00:00:00.000Z",
              updated_at: "2026-03-13T00:00:00.000Z"
            }
          }),
          { status: 200 }
        );
      }

      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    renderApp(["/login"]);

    await screen.findByLabelText("Email address");
    await userEvent.type(screen.getByLabelText("Email address"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "Password123!");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByText("Complete human verification to continue.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /solve challenge/i }));
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByText("Workspace command overview")).toBeInTheDocument();

    const loginCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/v2/auth/login"));
    expect(loginCall).toBeDefined();
    expect(JSON.parse(String(loginCall?.[1]?.body))).toMatchObject({
      cf_turnstile_response: "turnstile-token"
    });
  });

  it("submits turnstile tokens with registration requests", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);

      if (url.endsWith("/api/v2/auth/refresh")) {
        return new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 });
      }

      if (url.endsWith("/api/v2/auth/register")) {
        return new Response(
          JSON.stringify({
            access_token: "header.eyJmcGMiOmZhbHNlfQ.signature",
            user: {
              id: "user-3",
              email: "owner@example.com",
              role: "workspace_admin",
              status: "active",
              email_verified: false,
              force_password_change: false,
              workspace_id: "workspace-3",
              created_at: "2026-03-13T00:00:00.000Z",
              updated_at: "2026-03-13T00:00:00.000Z"
            },
            workspace: {
              id: "workspace-3",
              slug: "agent-lab",
              display_name: "Agent Lab",
              tier: "free",
              status: "active",
              owner_user_id: "user-3",
              created_at: "2026-03-13T00:00:00.000Z",
              updated_at: "2026-03-13T00:00:00.000Z"
            }
          }),
          { status: 201 }
        );
      }

      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    renderApp(["/register"]);

    await screen.findByLabelText("Display name");
    await userEvent.type(screen.getByLabelText("Display name"), "Agent Lab");
    await userEvent.type(screen.getByLabelText("Email address"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("Workspace slug"), "agent-lab");
    await userEvent.type(screen.getByLabelText("Password"), "Password123!");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /solve challenge/i }));
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    expect(await screen.findByText("Workspace command overview")).toBeInTheDocument();

    const registerCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/v2/auth/register"));
    expect(registerCall).toBeDefined();
    expect(JSON.parse(String(registerCall?.[1]?.body))).toMatchObject({
      cf_turnstile_response: "turnstile-token"
    });
  });
});
