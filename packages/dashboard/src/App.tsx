import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth/ProtectedRoute.js";
import { PublicOnlyRoute } from "./auth/PublicOnlyRoute.js";
import { Layout } from "./components/Layout.js";
import { AnalyticsPage } from "./pages/Analytics.js";
import { ApprovalsPage } from "./pages/Approvals.js";
import { AuditPage } from "./pages/Audit.js";
import { BillingPage } from "./pages/Billing.js";
import { ChangePasswordPage } from "./pages/ChangePassword.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { ForgotPasswordPage } from "./pages/ForgotPassword.js";
import { AgentsPage } from "./pages/Agents.js";
import { LoginPage } from "./pages/Login.js";
import { MembersPage } from "./pages/Members.js";
import { RegisterPage } from "./pages/Register.js";
import { SettingsPage } from "./pages/Settings.js";

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <RegisterPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/change-password"
        element={
          <ProtectedRoute allowForcePasswordChange>
            <ChangePasswordPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <PublicOnlyRoute>
            <ForgotPasswordPage />
          </PublicOnlyRoute>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route
          index
          element={
            <ProtectedRoute adminOnly>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin", "workspace_operator"]}>
              <AgentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/members"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin"]}>
              <MembersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/audit"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin", "workspace_operator", "workspace_viewer"]}>
              <AuditPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/audit/exchange/:exchangeId"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin", "workspace_operator", "workspace_viewer"]}>
              <AuditPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/approvals"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin", "workspace_operator", "workspace_viewer"]}>
              <ApprovalsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/billing"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin"]}>
              <BillingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/analytics"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin", "workspace_operator"]}>
              <AnalyticsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute allowedRoles={["workspace_admin"]}>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
