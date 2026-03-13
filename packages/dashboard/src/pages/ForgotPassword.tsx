import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell.js";

export function ForgotPasswordPage() {
  return (
    <AuthShell
      eyebrow="Recovery path"
      heroBody="SMTP-backed reset workflows land in a later phase. For now, password recovery stays operator-managed."
      heroTitle={
        <>
          Contact your <span>workspace administrator</span>.
        </>
      }
      metrics={[
        { label: "Recovery mode", value: "manual" },
        { label: "SMTP", value: "pending" },
        { label: "Fallback", value: "admin" }
      ]}
      subtitle="Forgot-password is intentionally a placeholder until outbound email is introduced."
      title="Password recovery"
      footer={
        <p>
          Return to <Link to="/login">login</Link>
        </p>
      }
    >
      <div className="info-card">
        <div className="card-title">Current behavior</div>
        <p className="hero-card__body">
          Ask a workspace administrator to rotate your account password from the Members page once Milestone 3 lands.
        </p>
      </div>
    </AuthShell>
  );
}
