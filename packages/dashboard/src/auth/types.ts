export type UserRole = "workspace_admin" | "workspace_operator" | "workspace_viewer";

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  status: "active" | "suspended" | "deleted";
  email_verified: boolean;
  force_password_change: boolean;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  display_name: string;
  tier: string;
  status: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}
