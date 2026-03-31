import { ArrowRight, Lock } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiBaseUrl } from "../api/client.js";
import { AuthShell } from "../components/AuthShell.js";
import { FormField } from "../components/FormField.js";

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return new Error(payload?.message ?? payload?.error ?? fallback);
}

export function ResetPasswordPage() {
  const { t } = useTranslation(["auth", "common"]);
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
      setError(t("auth:resetPassword.errorMissingToken"));
      return;
    }

    if (nextPassword !== confirmPassword) {
      setError(t("auth:resetPassword.errorMismatch"));
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
        throw await readError(response, t("auth:resetPassword.errorDefault"));
      }

      navigate("/login", {
        replace: true,
        state: {
          notice: t("auth:login.noticePasswordReset")
        }
      });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : t("auth:resetPassword.errorDefault"));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow={t("auth:resetPassword.sectionLabel")}
      heroBody={t("auth:resetPassword.heroBody")}
      heroTitle={
        <Trans i18nKey="auth:resetPassword.heroTitle" components={[<span key="emphasis" />]} />
      }
      metrics={[
        { label: t("auth:resetPassword.metricTokenPolicy"), value: t("auth:resetPassword.metricTokenPolicyValue") },
        { label: t("auth:resetPassword.metricSessionImpact"), value: t("auth:resetPassword.metricSessionImpactValue") },
        { label: t("auth:resetPassword.metricPasswordPolicy"), value: t("auth:resetPassword.metricPasswordPolicyValue") }
      ]}
      subtitle={t("auth:resetPassword.subtitle")}
      title={t("auth:resetPassword.title")}
      footer={
        <p>
          <Trans i18nKey="auth:resetPassword.backToLogin" components={[<Link key="login" to="/login" />]} />
        </p>
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <FormField
          autoComplete="new-password"
          data-testid="reset-password-new"
          icon={<Lock size={18} />}
          label={t("auth:resetPassword.newPasswordLabel")}
          onChange={(event) => setNextPassword(event.target.value)}
          required
          type="password"
          value={nextPassword}
        />
        <FormField
          autoComplete="new-password"
          data-testid="reset-password-confirm"
          icon={<Lock size={18} />}
          label={t("auth:resetPassword.confirmPasswordLabel")}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          type="password"
          value={confirmPassword}
        />
        <button className="primary-button primary-button--full" data-testid="reset-password-submit" disabled={pending} type="submit">
          {pending ? t("auth:resetPassword.submitting") : t("auth:resetPassword.submitButton")}
          <ArrowRight size={16} />
        </button>
      </form>
    </AuthShell>
  );
}
