import { ArrowRight, Eye, Lock, Mail } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { firstAllowedRoute } from "../auth/ProtectedRoute.js";
import { useAuth } from "../auth/useAuth.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";
import { TurnstileWidget } from "../components/TurnstileWidget.js";
import { turnstileEnabled } from "../security/turnstile.js";

export function LoginPage() {
  const { t } = useTranslation(["auth", "common"]);
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresTurnstile = turnstileEnabled();
  const handleTurnstileChange = useCallback((token: string | null) => {
    setTurnstileToken(token);
    setError((current) => (current === t("auth:login.errorTurnstile") ? null : current));
  }, [t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (requiresTurnstile && !turnstileToken) {
      setError(t("auth:login.errorTurnstile"));
      return;
    }

    setPending(true);
    setError(null);

    try {
      const session = await login(email, password, turnstileToken);
      const redirectTo = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
      navigate(redirectTo ?? firstAllowedRoute(session.user.role), { replace: true });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : t("auth:login.errorDefault"));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow={t("auth:login.title")}
      heroBody={t("auth:shell.heroSubtitle")}
      heroTitle={
        <Trans i18nKey="auth:shell.heroTitle" />
      }
      metrics={[
        { label: t("auth:shell.metricEncryption"), value: t("auth:shell.metricEncryptionValue") },
        { label: t("auth:shell.metricRotation"), value: t("auth:shell.metricRotationValue") },
        { label: t("auth:shell.metricSecretDelivery"), value: t("auth:shell.metricSecretDeliveryValue") }
      ]}
      subtitle={t("auth:login.subtitle")}
      title={t("auth:login.title")}
      footer={
        <p>
          <Trans i18nKey="auth:login.noAccount" /> <Link to="/register">{t("auth:login.registerLink")}</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {typeof (location.state as { notice?: string } | null)?.notice === "string"
          ? <div className="turnstile-placeholder turnstile-placeholder--info">{(location.state as { notice: string }).notice}</div>
          : null}
        {error ? <div className="error-banner">{error}</div> : null}
        <FormField
          autoComplete="email"
          data-testid="login-email"
          icon={<Mail size={18} />}
          label={t("auth:login.emailLabel")}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t("auth:login.emailPlaceholder")}
          required
          type="email"
          value={email}
        />
        <FormField
          autoComplete="current-password"
          data-testid="login-password"
          icon={<Lock size={18} />}
          label={t("auth:login.passwordLabel")}
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

        <TurnstileWidget onTokenChange={handleTurnstileChange} />

        <div className="auth-form__actions">
          <Link className="text-link" to="/forgot-password">
            {t("auth:login.forgotPassword")}
          </Link>
          <button className="primary-button" data-testid="login-submit" disabled={pending} type="submit">
            {pending ? t("auth:login.submitting") : t("auth:login.submitButton")}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
