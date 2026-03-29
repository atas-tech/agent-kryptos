import { ArrowRight, Lock } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiBaseUrl } from "../api/client.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return new Error(payload?.message ?? payload?.error ?? fallback);
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => searchParams.get("token")?.trim() ?? "", [searchParams]);
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) {
      setError("Password reset token is missing.");
      return;
    }

    if (nextPassword !== confirmPassword) {
      setError("The new password confirmation does not match.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl()}/api/v2/auth/reset-password`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          token,
          next_password: nextPassword
        })
      });

      if (!response.ok) {
        throw await readError(response, "Password reset failed");
      }

      navigate("/login", {
        replace: true,
        state: {
          notice: "Password reset complete. Sign in with your new password."
        }
      });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Password reset failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Reset access"
      heroBody="Apply a new password to invalidate the issued recovery token and rotate any active sessions."
      heroTitle={
        <>
          Set a fresh <span>workspace password</span>.
        </>
      }
      metrics={[
        { label: "Token policy", value: "single-use" },
        { label: "Session impact", value: "revoked" },
        { label: "Password policy", value: "8+ chars" }
      ]}
      subtitle="Use the recovery link from your email to complete a password reset."
      title="Reset password"
      footer={
        <p>
          Back to <Link to="/login">login</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
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
          {pending ? "Resetting..." : "Apply new password"}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
