import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { firstAllowedRoute } from "./ProtectedRoute.js";
import { useAuth } from "./useAuth.js";

interface PublicOnlyRouteProps {
  children: ReactNode;
}

export function PublicOnlyRoute({ children }: PublicOnlyRouteProps) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div className="dashboard-loading">
        <div className="status-pill">Initializing secure workspace</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to={user?.force_password_change ? "/change-password" : firstAllowedRoute(user?.role)} replace />;
  }

  return <>{children}</>;
}
