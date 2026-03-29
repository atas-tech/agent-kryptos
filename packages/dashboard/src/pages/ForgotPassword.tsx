import { ArrowRight, Mail, ShieldAlert } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["auth", "common"]);
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const requiresTurnstile = turnstileEnabled();
  const handleTurnstileChange = useCallback((token: string | null) => {
    setTurnstileToken(token);
    setError((current) => (current === t("auth:forgotPassword.errorTurnstile") ? null : current));
  }, [t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (requiresTurnstile && !turnstileToken) {
      setError(t("auth:forgotPassword.errorTurnstile"));
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
        throw await readError(response, t("auth:forgotPassword.errorDefault"));
      }

      setSubmitted(true);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : t("auth:forgotPassword.errorDefault"));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow={t("auth:forgotPassword.sectionLabel")}
      heroBody={t("auth:forgotPassword.heroBody")}
      heroTitle={
        <Trans i18nKey="auth:forgotPassword.heroTitle" />
      }
      metrics={[
        { label: t("auth:forgotPassword.metricToken"), value: t("auth:forgotPassword.metricTokenValue") },
        { label: t("auth:forgotPassword.metricDelivery"), value: t("auth:forgotPassword.metricDeliveryValue") },
        { label: t("auth:forgotPassword.metricGate"), value: t("auth:forgotPassword.metricGateValue") }
      ]}
      subtitle={t("auth:forgotPassword.subtitle")}
      title={t("auth:forgotPassword.title")}
      footer={
        <p>
          <Trans i18nKey="auth:forgotPassword.backToLogin" components={[<Link key="login" to="/login" />]} />
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {submitted ? (
          <div className="turnstile-placeholder turnstile-placeholder--info">
            <ShieldAlert size={18} />
            <div>
              <strong>{t("auth:forgotPassword.successTitle")}</strong>
              <span>{t("auth:forgotPassword.successBody")}</span>
            </div>
          </div>
        ) : null}
        {error ? <div className="error-banner">{error}</div> : null}
        <FormField
          autoComplete="email"
          icon={<Mail size={18} />}
          label={t("auth:forgotPassword.emailLabel")}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t("auth:forgotPassword.emailPlaceholder")}
          required
          type="email"
          value={email}
        />
        <TurnstileWidget onTokenChange={handleTurnstileChange} />
        <button className="primary-button primary-button--full" disabled={pending} type="submit">
          {pending ? t("auth:forgotPassword.submitting") : t("auth:forgotPassword.submitButton")}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
