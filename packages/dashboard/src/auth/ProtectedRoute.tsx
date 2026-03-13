import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth.js";
import type { UserRole } from "./types.js";

interface ProtectedRouteProps {
  allowedRoles?: UserRole[];
  adminOnly?: boolean;
  allowForcePasswordChange?: boolean;
  children?: ReactNode;
}

function decodeForcePasswordChange(accessToken: string | null): boolean {
  if (!accessToken) {
    return false;
  }

  try {
    const payload = JSON.parse(window.atob(accessToken.split(".")[1] ?? ""));
    return payload.fpc === true;
  } catch {
    return false;
  }
}

export function firstAllowedRoute(role: UserRole | undefined): string {
  switch (role) {
    case "workspace_admin":
      return "/";
    case "workspace_operator":
      return "/agents";
    case "workspace_viewer":
    default:
      return "/audit";
  }
}

export function ProtectedRoute({
  allowedRoles,
  adminOnly = false,
  allowForcePasswordChange = false,
  children
}: ProtectedRouteProps) {
  const { accessToken, isAuthenticated, isLoading, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="dashboard-loading">
        <div className="status-pill">Initializing secure workspace</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const forcePasswordChange = user?.force_password_change || decodeForcePasswordChange(accessToken);
  if (forcePasswordChange && !allowForcePasswordChange && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  if (adminOnly && user?.role !== "workspace_admin") {
    return <Navigate to={firstAllowedRoute(user?.role)} replace />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return <Navigate to={firstAllowedRoute(user.role)} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
