import { ArrowRight, Eye, Lock, Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { firstAllowedRoute } from "../auth/ProtectedRoute.js";
import { useAuth } from "../auth/useAuth.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const session = await login(email, password);
      const redirectTo = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      navigate(redirectTo ?? firstAllowedRoute(session.user.role), { replace: true });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to authenticate");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Secure entry"
      heroBody="Operate agent workflows, approvals, and audit trails through an encrypted operations surface."
      heroTitle={
        <>
          The gold standard for <span>AI secret management</span>.
        </>
      }
      metrics={[
        { label: "Uptime SLA", value: "99.9%" },
        { label: "Encryption", value: "256-bit" },
        { label: "Compliance", value: "SOC2" }
      ]}
      subtitle="Enter your workspace credentials to continue into the operator shell."
      title="Welcome back"
      footer={
        <p>
          Don&apos;t have an account? <Link to="/register">Create a workspace</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <FormField
          autoComplete="email"
          icon={<Mail size={18} />}
          label="Email address"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@company.com"
          required
          type="email"
          value={email}
        />
        <FormField
          autoComplete="current-password"
          icon={<Lock size={18} />}
          label="Password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••"
          required
          trailing={
            <button className="trailing-button" onClick={() => setShowPassword((value) => !value)} type="button">
              <Eye size={16} />
            </button>
          }
          type={showPassword ? "text" : "password"}
          value={password}
        />

        <div className="turnstile-placeholder">
          <div className="checkbox-proxy" />
          <div>
            <strong>Verify you are human</strong>
            <span>Turnstile placeholder until Phase 3B Milestone 6.</span>
          </div>
        </div>

        <div className="auth-form__actions">
          <Link className="text-link" to="/forgot-password">
            Forgot password?
          </Link>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "Authenticating..." : "Login to portal"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
