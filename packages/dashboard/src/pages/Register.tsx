import { ArrowRight, Eye, Lock, Mail, User2, Workflow } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";
import { TurnstileWidget } from "../components/TurnstileWidget.js";
import { turnstileEnabled } from "../security/turnstile.js";

export function RegisterPage() {
  const { t } = useTranslation(["auth", "common"]);
  const { register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresTurnstile = turnstileEnabled();
  const handleTurnstileChange = useCallback((token: string | null) => {
    setTurnstileToken(token);
    setError((current) => (current === t("auth:register.errorTurnstile") ? null : current));
  }, [t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!acceptedTerms) {
      setError(t("auth:register.termsRequired"));
      return;
    }

    if (requiresTurnstile && !turnstileToken) {
      setError(t("auth:register.errorTurnstile"));
      return;
    }

    setPending(true);
    setError(null);

    try {
      const session = await register({ email, password, workspaceSlug, displayName, turnstileToken });
      navigate(session.user.role === "workspace_admin" ? "/" : "/agents", { replace: true });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : t("auth:register.errorDefault"));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow={t("auth:register.title")}
      heroBody={t("auth:registerShell.heroSubtitle")}
      heroTitle={
        <Trans i18nKey="auth:registerShell.heroTitle" />
      }
      metrics={[
        { label: t("auth:registerShell.metricStorage"), value: t("auth:registerShell.metricStorageValue") },
        { label: t("auth:registerShell.metricCompliance"), value: t("auth:registerShell.metricComplianceValue") },
        { label: t("auth:registerShell.metricSessions"), value: t("auth:registerShell.metricSessionsValue") }
      ]}
      subtitle={t("auth:register.subtitle")}
      title={t("auth:register.title")}
      footer={
        <p>
          <Trans i18nKey="auth:register.hasAccount" /> <Link to="/login">{t("auth:register.loginLink")}</Link>
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <FormField
          autoComplete="organization"
          icon={<User2 size={18} />}
          label={t("auth:register.displayNameLabel")}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={t("auth:register.displayNamePlaceholder")}
          required
          value={displayName}
        />
        <FormField
          autoComplete="email"
          icon={<Mail size={18} />}
          label={t("auth:register.emailLabel")}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t("auth:register.emailPlaceholder")}
          required
          type="email"
          value={email}
        />
        <FormField
          icon={<Workflow size={18} />}
          label={t("auth:register.workspaceSlugLabel")}
          onChange={(event) => setWorkspaceSlug(event.target.value)}
          placeholder={t("auth:register.workspaceSlugPlaceholder")}
          required
          trailing={<span className="slug-suffix">.blindpass.atas.tech</span>}
          value={workspaceSlug}
        />
        <FormField
          autoComplete="new-password"
          icon={<Lock size={18} />}
          label={t("auth:register.passwordLabel")}
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
            {t("auth:register.terms")}
          </span>
        </label>

        <TurnstileWidget onTokenChange={handleTurnstileChange} />

        <button className="primary-button primary-button--full" disabled={pending} type="submit">
          {pending ? t("auth:register.submitting") : t("auth:register.submitButton")}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
