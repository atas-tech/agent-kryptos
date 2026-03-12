export type UserRole = "workspace_admin" | "workspace_operator" | "workspace_viewer";

const USER_ROLE_PRIORITY: Record<UserRole, number> = {
  workspace_viewer: 0,
  workspace_operator: 1,
  workspace_admin: 2
};

export function isUserRole(value: unknown): value is UserRole {
  return value === "workspace_admin" || value === "workspace_operator" || value === "workspace_viewer";
}

export function checkPermission(userRole: UserRole, requiredRole: UserRole): boolean {
  return USER_ROLE_PRIORITY[userRole] >= USER_ROLE_PRIORITY[requiredRole];
}
