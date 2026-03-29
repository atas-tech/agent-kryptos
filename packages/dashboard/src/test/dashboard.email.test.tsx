import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("dashboard email flows", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("submits forgot-password requests and shows the generic confirmation", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v2/auth/refresh")) {
        return new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 });
      }

      if (url.endsWith("/api/v2/auth/forgot-password")) {
        return new Response(
          JSON.stringify({ message: "If the account exists, password reset instructions have been issued." }),
          { status: 200 }
        );
      }

      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    renderApp(["/forgot-password"]);

    await screen.findByText("Password recovery");
    await userEvent.type(screen.getByLabelText("Email address"), "owner@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    const forgotCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/v2/auth/forgot-password"));
    expect(forgotCall).toBeDefined();
    expect(JSON.parse(String((forgotCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      email: "owner@example.com"
    });
  });

  it("resets a password from the public reset route and returns to login", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v2/auth/refresh")) {
        return new Response(JSON.stringify({ error: "Invalid refresh token" }), { status: 401 });
      }

      if (url.endsWith("/api/v2/auth/reset-password")) {
        return new Response(JSON.stringify({ message: "Password reset complete" }), { status: 200 });
      }

      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    renderApp(["/reset-password?token=reset-token-123"]);

    await screen.findByText("Reset password");
    await userEvent.type(screen.getByLabelText("New password"), "NewPassword123!");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "NewPassword123!");
    await userEvent.click(screen.getByRole("button", { name: /apply new password/i }));

    expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
    expect(await screen.findByText("Password reset complete. Sign in with your new password.")).toBeInTheDocument();
  });

  it("shows local delivery messaging when verification resend logs a link instead of sending mail", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v2/auth/refresh")) {
        return new Response(
          JSON.stringify({
            access_token: "header.eyJmcGMiOmZhbHNlfQ.signature",
            user: {
              id: "user-1",
              email: "owner@example.com",
              role: "workspace_admin",
              status: "active",
              email_verified: false,
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

      if (url.endsWith("/api/v2/dashboard/summary")) {
        return new Response(
          JSON.stringify({
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
              status: "inactive",
              billing_provider: null,
              provider_customer_id: null,
              provider_subscription_id: null,
              subscription_status: "none"
            },
            counts: {
              active_agents: 0,
              active_members: 1
            },
            quota: {
              secret_requests: {
                used: 0,
                limit: 10,
                reset_at: 1760000000
              },
              agents: {
                used: 0,
                limit: 2
              },
              members: {
                used: 1,
                limit: 2
              },
              a2a_exchange_available: false
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/api/v2/auth/retrigger-verification")) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            message: "Verification link logged for local delivery",
            delivery: {
              mode: "logged",
              provider: "local-log"
            }
          }),
          { status: 200 }
        );
      }

      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    renderApp(["/"]);

    await screen.findByText("Workspace command overview");
    await userEvent.click(screen.getByRole("button", { name: /resend verification/i }));

    expect(await screen.findByText("Verification link issued locally")).toBeInTheDocument();
    expect(await screen.findByText("Check the server output for the verification link in this local environment.")).toBeInTheDocument();
  });
});
