import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MembersPage } from "../Members.js";
import { apiRequest } from "../../api/client.js";

vi.mock("../../api/client.js", () => ({
  apiRequest: vi.fn(),
  ApiError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
}));

const mockMembers = [
  {
    id: "admin-1",
    email: "admin@example.com",
    role: "workspace_admin",
    status: "active",
    email_verified: true,
    force_password_change: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "viewer-1",
    email: "viewer@example.com",
    role: "workspace_viewer",
    status: "active",
    email_verified: true,
    force_password_change: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
];

describe("MembersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders members and prevents last admin demotion", async () => {
    (apiRequest as any).mockImplementation((url: string) => {
      if (url.includes("/api/v2/members")) {
        return Promise.resolve({
          members: mockMembers,
          next_cursor: null
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<MembersPage />);

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("viewer@example.com")).toBeInTheDocument();

    // The last admin should have their role selector disabled
    const adminRoleSelect = screen.getByLabelText("Role for admin@example.com");
    expect(adminRoleSelect).toBeDisabled();

    // The viewer should have their role selector enabled
    const viewerRoleSelect = screen.getByLabelText("Role for viewer@example.com");
    expect(viewerRoleSelect).not.toBeDisabled();
  });

  it("enforces temporary password rules in create form", async () => {
    (apiRequest as any).mockResolvedValue({ members: [], next_cursor: null });
    const user = userEvent.setup();

    render(<MembersPage />);

    await screen.findByText("0 rows loaded");
    await user.click(screen.getByRole("button", { name: /Add member/i }));

    const passwordInput = screen.getByLabelText("Temporary password");

    // Too short
    await user.type(passwordInput, "short");
    expect(await screen.findByText(/Temporary password strength: too short/i)).toBeInTheDocument();
    
    // Obvious weak password
    await user.clear(passwordInput);
    await user.type(passwordInput, "password123!");
    expect(await screen.findByText(/Temporary password strength: too weak/i)).toBeInTheDocument();

    // Valid strong password
    await user.clear(passwordInput);
    await user.type(passwordInput, "ComplexPassword123!");
    expect(await screen.findByText(/Temporary password strength: (strong|very strong)/i)).toBeInTheDocument();
  });

  it("handles pagination 'Load more' click", async () => {
    const page1 = { members: [mockMembers[0]], next_cursor: "cursor-1" };
    const page2 = { members: [mockMembers[1]], next_cursor: null };

    (apiRequest as any)
      .mockResolvedValueOnce(page1) // Initial load members
      .mockResolvedValueOnce(page1) // Initial load admins
      .mockResolvedValueOnce(page2) // Load more members
      .mockResolvedValueOnce(page2); // Load more admins (triggered by Promise.all in loadMembers)

    const user = userEvent.setup();
    render(<MembersPage />);

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.queryByText("viewer@example.com")).not.toBeInTheDocument();

    const loadMoreButton = screen.getByRole("button", { name: /Load more/i });
    await user.click(loadMoreButton);

    expect(await screen.findByText("viewer@example.com")).toBeInTheDocument();
  });
});
