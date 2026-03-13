import { ArrowRight, Lock, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { firstAllowedRoute } from "../auth/ProtectedRoute.js";
import { useAuth } from "../auth/useAuth.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";

export function ChangePasswordPage() {
  const { changePassword, user } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (nextPassword !== confirmPassword) {
      setError("The new password confirmation does not match.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      await changePassword(currentPassword, nextPassword);
      navigate(firstAllowedRoute(user?.role), { replace: true });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Password change failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Credential rotation"
      heroBody="Your administrator issued a temporary password. Rotate it now before accessing workspace routes."
      heroTitle={
        <>
          Replace your <span>temporary credential</span>.
        </>
      }
      metrics={[
        { label: "Token scope", value: "session" },
        { label: "Password policy", value: "8+ chars" },
        { label: "Access gate", value: "enforced" }
      ]}
      subtitle="Complete the required password rotation before continuing into the workspace."
      title="Change password"
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="turnstile-placeholder turnstile-placeholder--warning">
          <ShieldAlert size={18} />
          <div>
            <strong>Protected action</strong>
            <span>Your current session is restricted until this password update succeeds.</span>
          </div>
        </div>
        <FormField
          autoComplete="current-password"
          icon={<Lock size={18} />}
          label="Current password"
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
          type="password"
          value={currentPassword}
        />
        <FormField
          autoComplete="new-password"
          icon={<Lock size={18} />}
          label="New password"
          onChange={(event) => setNextPassword(event.target.value)}
          required
          type="password"
          value={nextPassword}
        />
        <FormField
          autoComplete="new-password"
          icon={<Lock size={18} />}
          label="Confirm new password"
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          type="password"
          value={confirmPassword}
        />
        <button className="primary-button primary-button--full" disabled={pending} type="submit">
          {pending ? "Updating..." : "Apply new password"}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
