import { AlertTriangle, Bot, KeyRound, ShieldCheck, Users } from "lucide-react";
import { useAuth } from "../auth/useAuth.js";

export function DashboardPage() {
  const { workspace, user } = useAuth();

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div>
          <div className="section-label">System live</div>
          <h2 className="hero-card__title">Workspace command overview</h2>
          <p className="hero-card__body">
            Monitor access posture for <strong>{workspace?.display_name ?? "your workspace"}</strong> and use the
            sidebar to move into the next Milestone 3 and 4 operational surfaces.
          </p>
        </div>
        <div className="status-grid">
          <div className="status-card">
            <strong>{workspace?.tier ?? "free"}</strong>
            <span>workspace tier</span>
          </div>
          <div className="status-card">
            <strong>{user?.role.replace("workspace_", "") ?? "admin"}</strong>
            <span>active role</span>
          </div>
          <div className="status-card">
            <strong>{workspace?.status ?? "active"}</strong>
            <span>workspace status</span>
          </div>
        </div>
      </div>

      <div className="content-grid content-grid--quad">
        {[
          { icon: ShieldCheck, title: "Security score", value: "98%", copy: "Encryption active across the control plane." },
          { icon: Bot, title: "Agents", value: "Ready", copy: "Enrollment scaffolding is live for Milestone 3 wiring." },
          { icon: Users, title: "Members", value: "Ready", copy: "Role-aware navigation is enforcing current access." },
          { icon: KeyRound, title: "Rotation", value: "Manual", copy: "Emergency key actions will connect to agent APIs next." },
          {
            icon: AlertTriangle,
            title: "Approvals",
            value: "Inbox",
            copy: "Viewer-safe placeholder route is available for future exchange actions."
          }
        ].map(({ icon: Icon, title, value, copy }) => (
          <article key={title} className="info-card">
            <div className="info-card__icon">
              <Icon size={18} />
            </div>
            <div className="card-title">{title}</div>
            <div className="metric-value">{value}</div>
            <p className="hero-card__body">{copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
