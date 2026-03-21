import { ArrowRight, Eye, Lock, Mail, User2, Workflow } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!acceptedTerms) {
      setError("Accept the terms to initialize a workspace.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const session = await register({ email, password, workspaceSlug, displayName });
      navigate(session.user.role === "workspace_admin" ? "/" : "/agents", { replace: true });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to create workspace");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Initialize protocol"
      heroBody="Secure autonomous agents with encrypted workflows, dynamic secret injection, and enterprise-grade key rotation."
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
      subtitle="Create your administrative workspace to begin orchestration."
      title="Initialize protocol"
      footer={
        <p>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <FormField
          autoComplete="organization"
          icon={<User2 size={18} />}
          label="Display name"
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Acme Security"
          required
          value={displayName}
        />
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
          icon={<Workflow size={18} />}
          label="Workspace slug"
          onChange={(event) => setWorkspaceSlug(event.target.value)}
          placeholder="acme-corp"
          required
          trailing={<span className="slug-suffix">.blindpass.ai</span>}
          value={workspaceSlug}
        />
        <FormField
          autoComplete="new-password"
          icon={<Lock size={18} />}
          label="Master password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••••••"
          required
          trailing={
            <button className="trailing-button" onClick={() => setShowPassword((value) => !value)} type="button">
              <Eye size={16} />
            </button>
          }
          type={showPassword ? "text" : "password"}
          value={password}
        />

        <label className="checkbox-row">
          <input checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} type="checkbox" />
          <span>
            I agree to the encrypted data handling terms and privacy policy for this workspace.
          </span>
        </label>

        <button className="primary-button primary-button--full" disabled={pending} type="submit">
          {pending ? "Provisioning..." : "Create my account"}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
