import { ArrowRight, Mail, ShieldAlert } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiBaseUrl } from "../api/client.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";
import { TurnstileWidget } from "../components/TurnstileWidget.js";
import { turnstileEnabled } from "../security/turnstile.js";

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return new Error(payload?.message ?? payload?.error ?? fallback);
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const requiresTurnstile = turnstileEnabled();
  const handleTurnstileChange = useCallback((token: string | null) => {
    setTurnstileToken(token);
    setError((current) => (current === "Complete human verification to continue." ? null : current));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (requiresTurnstile && !turnstileToken) {
      setError("Complete human verification to continue.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl()}/api/v2/auth/forgot-password`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email,
          cf_turnstile_response: turnstileToken ?? undefined
        })
      });

      if (!response.ok) {
        throw await readError(response, "Password recovery failed");
      }

      setSubmitted(true);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Password recovery failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Recovery path"
      heroBody="Request a time-limited reset link. The response stays generic so account existence is never exposed at the edge."
      heroTitle={
        <>
          Recover access <span>without operator handoffs</span>.
        </>
      }
      metrics={[
        { label: "Reset token", value: "single-use" },
        { label: "Delivery path", value: "email" },
        { label: "Abuse gate", value: "shielded" }
      ]}
      subtitle="Enter your workspace email address and we will issue reset instructions if the account is eligible."
      title="Password recovery"
      footer={
        <p>
          Return to <Link to="/login">login</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {submitted ? (
          <div className="turnstile-placeholder turnstile-placeholder--info">
            <ShieldAlert size={18} />
            <div>
              <strong>Check your inbox</strong>
              <span>If the account exists, password reset instructions have been issued.</span>
            </div>
          </div>
        ) : null}
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
        <TurnstileWidget onTokenChange={handleTurnstileChange} />
        <button className="primary-button primary-button--full" disabled={pending} type="submit">
          {pending ? "Issuing reset..." : "Send reset link"}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
