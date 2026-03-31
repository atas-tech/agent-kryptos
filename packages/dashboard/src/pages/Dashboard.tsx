import { AlertTriangle, BadgeDollarSign, Bot, KeyRound, ShieldCheck, Users, Mail, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAuth } from "../auth/useAuth.js";
import { QuotaMeter } from "../components/QuotaMeter.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TurnstileWidget } from "../components/TurnstileWidget.js";
import { useDashboardSummary } from "../hooks/useDashboardSummary.js";
import { apiRequest } from "../api/client.js";
import { turnstileEnabled } from "../security/turnstile.js";

function formatRoleLabel(role: string | null | undefined, t: (key: string) => string): string {
  switch (role) {
    case "workspace_operator":
      return t("dashboard:summary.roles.operator");
    case "workspace_viewer":
      return t("dashboard:summary.roles.viewer");
    case "workspace_admin":
    default:
      return t("dashboard:summary.roles.admin");
  }
}

function formatTierLabel(tier: string | null | undefined, t: (key: string) => string): string {
  switch (tier) {
    case "standard":
      return t("dashboard:summary.tiers.standard");
    case "free":
    default:
      return t("dashboard:summary.tiers.free");
  }
}

function formatWorkspaceStatus(status: string | null | undefined, t: (key: string) => string): string {
  switch (status) {
    case "suspended":
      return t("common:suspended");
    case "active":
    default:
      return t("common:active");
  }
}

export function DashboardPage() {
  const { t } = useTranslation(["dashboard", "common", "auth"]);
  const { workspace, user, setWorkspaceSummary } = useAuth();
  const { summary, loading, error, refresh } = useDashboardSummary();
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "success" | "logged" | "error">("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [showResendTurnstile, setShowResendTurnstile] = useState(false);
  const requiresTurnstile = turnstileEnabled();

  const handleTurnstileChange = useCallback((token: string | null) => {
    setTurnstileToken(token);
    setResendError((current) => (current === t("auth:login.errorTurnstile") ? null : current));
  }, [t]);

  const handleResendVerification = useCallback(async () => {
    if (requiresTurnstile && !turnstileToken) {
      setShowResendTurnstile(true);
      setResendError(null);
      return;
    }

    setResending(true);
    setResendStatus("idle");
    setResendError(null);
    try {
      const response = await apiRequest<{ delivery?: { mode?: "sent" | "logged" } }>(
        "/api/v2/auth/retrigger-verification",
        {
          method: "POST",
          body: JSON.stringify({
            cf_turnstile_response: turnstileToken || undefined
          })
        }
      );
      setResendStatus(response.delivery?.mode === "logged" ? "logged" : "success");
    } catch (err) {
      console.error("Failed to resend verification email:", err);
      setResendStatus("error");
      setResendError(err instanceof Error ? err.message : t("auth:verificationBanner.errorDefault"));
    } finally {
      setResending(false);
    }
  }, [requiresTurnstile, turnstileToken, t]);

  useEffect(() => {
    if (showResendTurnstile && turnstileToken && resendStatus === "idle" && !resending) {
      void handleResendVerification();
    }
  }, [turnstileToken, showResendTurnstile, resendStatus, resending, handleResendVerification]);

  useEffect(() => {
    if (summary?.workspace) {
      // Only update if something actually changed to avoid infinite loop
      const changed = 
        summary.workspace.tier !== workspace?.tier ||
        summary.workspace.display_name !== workspace?.display_name ||
        summary.workspace.status !== workspace?.status;

      if (changed) {
        setWorkspaceSummary({
          ...workspace,
          ...summary.workspace,
          owner_user_id: workspace?.owner_user_id ?? "",
          created_at: workspace?.created_at ?? new Date(0).toISOString(),
          updated_at: workspace?.updated_at ?? new Date().toISOString()
        });
      }
    }
  }, [setWorkspaceSummary, summary?.workspace, workspace?.id, workspace?.tier, workspace?.display_name, workspace?.status]);

  const activeWorkspace = summary?.workspace ?? workspace;
  const billing = summary?.billing;
  const counts = summary?.counts;
  const quota = summary?.quota;

  if (loading && !summary) {
    return (
      <section className="page-stack">
        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("dashboard:hero.sectionLabel")}</div>
              <h2 className="panel-card__title">{t("dashboard:hero.loadingTitle")}</h2>
              <p className="panel-card__body">{t("dashboard:hero.loadingBody")}</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page-stack">
      {user && !user.email_verified && (
        <div className="verification-banner">
          <div className="verification-banner__text">
            {resendStatus === "success" || resendStatus === "logged" ? (
              <>
                <CheckCircle2 size={20} className="text-success" />
                <div>
                  <strong>
                    {resendStatus === "logged"
                      ? t("dashboard:verification.loggedTitle")
                      : t("dashboard:verification.sentTitle")}
                  </strong>
                  <p className="hero-card__body">
                    {resendStatus === "logged"
                      ? t("dashboard:verification.loggedBody")
                      : t("dashboard:verification.sentBody")}
                  </p>
                </div>
              </>
            ) : (
              <>
                <Mail size={20} />
                <div>
                  <strong>{t("auth:verificationBanner.title")}</strong>
                  <p className="hero-card__body">{t("auth:verificationBanner.body")}</p>
                </div>
              </>
            )}
          </div>
          <div>
            {resendError ? <div className="error-banner">{resendError}</div> : null}
            {requiresTurnstile && showResendTurnstile ? <TurnstileWidget onTokenChange={handleTurnstileChange} /> : null}
            {resendStatus !== "success" && resendStatus !== "logged" ? (
              <button
                className="primary-button"
                disabled={resending}
                onClick={handleResendVerification}
                type="button"
              >
                {resending
                  ? t("auth:verificationBanner.resending")
                  : resendStatus === "error"
                    ? t("common:retry")
                    : showResendTurnstile && !turnstileToken
                      ? t("auth:login.verifyPrompt")
                      : t("auth:verificationBanner.resendButton")}
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="hero-card hero-card--dashboard">
        <div>
          <div className="section-label">{t("dashboard:summary.sectionLabel")}</div>
          <h2 className="hero-card__title">{t("dashboard:summary.title")}</h2>
          <p className="hero-card__body">
            <Trans
              components={{ strong: <strong /> }}
              i18nKey="dashboard:summary.body"
              values={{ workspace: activeWorkspace?.display_name ?? t("dashboard:summary.yourWorkspace") }}
            />
          </p>
        </div>
        <div className="status-grid">
          <div className="status-card">
            <strong>{formatTierLabel(activeWorkspace?.tier, t)}</strong>
            <span>{t("dashboard:summary.workspaceTier")}</span>
          </div>
          <div className="status-card">
            <strong>{formatRoleLabel(user?.role, t)}</strong>
            <span>{t("dashboard:summary.activeRole")}</span>
          </div>
          <div className="status-card">
            <strong>{formatWorkspaceStatus(activeWorkspace?.status, t)}</strong>
            <span>{t("dashboard:summary.workspaceStatus")}</span>
          </div>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="content-grid content-grid--quad">
        {[
          {
            icon: ShieldCheck,
            title: t("dashboard:cards.subscription.title"),
            value: billing?.subscription_status ?? t("dashboard:cards.subscription.none"),
            copy: billing?.billing_provider
              ? t("dashboard:cards.subscription.connected", { provider: billing.billing_provider })
              : t("dashboard:cards.subscription.notConnected")
          },
          {
            icon: Bot,
            title: t("dashboard:cards.agents.title"),
            value: counts ? String(counts.active_agents) : "0",
            copy: quota
              ? t("dashboard:cards.agents.copy", { used: quota.agents.used, limit: quota.agents.limit })
              : t("dashboard:cards.agents.loading")
          },
          {
            icon: Users,
            title: t("dashboard:cards.members.title"),
            value: counts ? String(counts.active_members) : "0",
            copy: quota
              ? t("dashboard:cards.members.copy", { used: quota.members.used, limit: quota.members.limit })
              : t("dashboard:cards.members.loading")
          },
          {
            icon: KeyRound,
            title: t("dashboard:cards.secretRequests.title"),
            value: quota ? `${quota.secret_requests.used}/${quota.secret_requests.limit}` : "0/0",
            copy: quota
              ? t("dashboard:cards.secretRequests.copy", {
                  date: new Date(quota.secret_requests.reset_at * 1000).toLocaleString()
                })
              : t("dashboard:cards.secretRequests.loading")
          },
          {
            icon: AlertTriangle,
            title: t("dashboard:cards.exchange.title"),
            value: quota?.a2a_exchange_available
              ? t("dashboard:cards.exchange.enabled")
              : t("dashboard:cards.exchange.locked"),
            copy: quota?.a2a_exchange_available
              ? t("dashboard:cards.exchange.available")
              : t("dashboard:cards.exchange.unavailable")
          },
          {
            icon: BadgeDollarSign,
            title: t("dashboard:cards.provider.title"),
            value: billing?.billing_provider ?? t("dashboard:cards.provider.none"),
            copy: billing?.provider_customer_id
              ? t("dashboard:cards.provider.connected")
              : t("dashboard:cards.provider.notConnected")
          }
        ].map(({ icon: Icon, title, value, copy }) => (
          <article key={title} className="info-card" data-testid={`summary-card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
            <div className="info-card__icon">
              <Icon size={18} />
            </div>
            <div className="card-title" data-testid="summary-card-title">{title}</div>
            <div className="metric-value" data-testid="summary-card-value">{value}</div>
            <p className="hero-card__body">{copy}</p>
          </article>
        ))}
      </div>

      {quota ? (
        <div className="section-grid">
          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("dashboard:quota.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("dashboard:quota.title")}</h3>
                <p className="panel-card__body">{t("dashboard:quota.body")}</p>
              </div>
              <div className="inline-actions">
                <StatusBadge tone={activeWorkspace?.tier === "standard" ? "success" : "warning"}>
                  {t("dashboard:quota.tierBadge", { tier: formatTierLabel(activeWorkspace?.tier, t) })}
                </StatusBadge>
                <StatusBadge tone={quota.a2a_exchange_available ? "success" : "neutral"}>
                  {quota.a2a_exchange_available
                    ? t("dashboard:quota.exchangeEnabled")
                    : t("dashboard:quota.exchangeLocked")}
                </StatusBadge>
              </div>
            </div>

            <div className="quota-grid">
              <QuotaMeter
                helper={t("dashboard:quota.secretRequestsHelper")}
                label={t("dashboard:quota.secretRequests")}
                limit={quota.secret_requests.limit}
                tone={quota.secret_requests.used >= quota.secret_requests.limit ? "danger" : "default"}
                used={quota.secret_requests.used}
              />
              <QuotaMeter
                helper={t("dashboard:quota.agentsHelper")}
                label={t("dashboard:quota.agents")}
                limit={quota.agents.limit}
                tone={quota.agents.used >= quota.agents.limit ? "warning" : "default"}
                used={quota.agents.used}
              />
              <QuotaMeter
                helper={t("dashboard:quota.membersHelper")}
                label={t("dashboard:quota.members")}
                limit={quota.members.limit}
                tone={quota.members.used >= quota.members.limit ? "warning" : "default"}
                used={quota.members.used}
              />
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("dashboard:billing.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("dashboard:billing.title")}</h3>
                <p className="panel-card__body">{t("dashboard:billing.body")}</p>
              </div>
            </div>

            <div className="detail-list">
              <div className="detail-list__item">
                <div className="meta-label">{t("dashboard:billing.provider")}</div>
                <div className="meta-value">{billing?.billing_provider ?? t("dashboard:billing.notConnected")}</div>
              </div>
              <div className="detail-list__item">
                <div className="meta-label">{t("dashboard:billing.subscriptionStatus")}</div>
                <div className="meta-value">{billing?.subscription_status ?? t("dashboard:billing.none")}</div>
              </div>
              <div className="detail-list__item">
                <div className="meta-label">{t("dashboard:billing.customerReference")}</div>
                <div className="meta-value">{billing?.provider_customer_id ?? t("dashboard:billing.pendingCheckout")}</div>
              </div>
            </div>

            <div className="inline-actions">
              <button className="ghost-button" onClick={() => void refresh()} type="button">
                {t("dashboard:billing.refresh")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
