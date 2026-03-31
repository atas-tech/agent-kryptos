import { ArrowRight, Lock, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { firstAllowedRoute } from "../auth/ProtectedRoute.js";
import { useAuth } from "../auth/useAuth.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";

export function ChangePasswordPage() {
  const { t } = useTranslation(["auth", "common"]);
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
      setError(t("auth:changePassword.errorMismatch"));
      return;
    }

    setPending(true);
    setError(null);

    try {
      await changePassword(currentPassword, nextPassword);
      navigate(firstAllowedRoute(user?.role), { replace: true });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : t("auth:changePassword.errorDefault"));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow={t("auth:changePassword.sectionLabel")}
      heroBody={t("auth:changePassword.heroBody")}
      heroTitle={
        <Trans i18nKey="auth:changePassword.heroTitle" components={[<span key="emphasis" />]} />
      }
      metrics={[
        { label: t("auth:changePassword.metricScope"), value: t("auth:changePassword.metricScopeValue") },
        { label: t("auth:changePassword.metricPolicy"), value: t("auth:changePassword.metricPolicyValue") },
        { label: t("auth:changePassword.metricGate"), value: t("auth:changePassword.metricGateValue") }
      ]}
      subtitle={t("auth:changePassword.subtitle")}
      title={t("auth:changePassword.title")}
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="turnstile-placeholder turnstile-placeholder--warning">
          <ShieldAlert size={18} />
          <div>
            <strong>{t("auth:changePassword.protectedActionTitle")}</strong>
            <span>{t("auth:changePassword.protectedActionBody")}</span>
          </div>
        </div>
        <FormField
          autoComplete="current-password"
          data-testid="change-password-current"
          icon={<Lock size={18} />}
          label={t("auth:changePassword.currentPasswordLabel")}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
          type="password"
          value={currentPassword}
        />
        <FormField
          autoComplete="new-password"
          data-testid="change-password-new"
          icon={<Lock size={18} />}
          label={t("auth:changePassword.newPasswordLabel")}
          onChange={(event) => setNextPassword(event.target.value)}
          required
          type="password"
          value={nextPassword}
        />
        <FormField
          autoComplete="new-password"
          data-testid="change-password-confirm"
          icon={<Lock size={18} />}
          label={t("auth:changePassword.confirmPasswordLabel")}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          type="password"
          value={confirmPassword}
        />
        <button className="primary-button primary-button--full" data-testid="change-password-submit" disabled={pending} type="submit">
          {pending ? t("auth:changePassword.submitting") : t("auth:changePassword.submitButton")}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
