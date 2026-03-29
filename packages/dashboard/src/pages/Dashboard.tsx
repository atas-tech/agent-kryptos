import { AlertTriangle, BadgeDollarSign, Bot, KeyRound, ShieldCheck, Users, Mail, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth.js";
import { QuotaMeter } from "../components/QuotaMeter.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TurnstileWidget } from "../components/TurnstileWidget.js";
import { useDashboardSummary } from "../hooks/useDashboardSummary.js";
import { apiRequest } from "../api/client.js";
import { turnstileEnabled } from "../security/turnstile.js";

export function DashboardPage() {
  const { workspace, user, setWorkspaceSummary } = useAuth();
  const { summary, loading, error, refresh } = useDashboardSummary();
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "success" | "logged" | "error">("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const requiresTurnstile = turnstileEnabled();
  const handleTurnstileChange = useCallback((token: string | null) => {
    setTurnstileToken(token);
    setResendError((current) => (current === "Complete human verification to continue." ? null : current));
  }, []);

  const handleResendVerification = async () => {
    if (requiresTurnstile && !turnstileToken) {
      setResendError("Complete human verification to continue.");
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
            cf_turnstile_response: turnstileToken ?? undefined
          })
        }
      );
      setResendStatus(response.delivery?.mode === "logged" ? "logged" : "success");
    } catch (err) {
      console.error("Failed to resend verification email:", err);
      setResendStatus("error");
      setResendError(err instanceof Error ? err.message : "Verification delivery failed");
    } finally {
      setResending(false);
    }
  };

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
              <div className="section-label">Workspace overview</div>
              <h2 className="panel-card__title">Loading dashboard summary</h2>
              <p className="panel-card__body">Reading workspace quotas, billing status, and operator counts.</p>
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
                  <strong>{resendStatus === "logged" ? "Verification link issued locally" : "Verification email sent"}</strong>
                  <p className="hero-card__body">
                    {resendStatus === "logged"
                      ? "Check the server output for the verification link in this local environment."
                      : "Please check your inbox for the new link."}
                  </p>
                </div>
              </>
            ) : (
              <>
                <Mail size={20} />
                <div>
                  <strong>Your email is not verified</strong>
                  <p className="hero-card__body">Verify your email to ensure uninterrupted access to all features.</p>
                </div>
              </>
            )}
          </div>
          <div>
            {resendError ? <div className="error-banner">{resendError}</div> : null}
            {requiresTurnstile ? <TurnstileWidget onTokenChange={handleTurnstileChange} /> : null}
            {resendStatus !== "success" && resendStatus !== "logged" ? (
              <button
                className="primary-button"
                disabled={resending}
                onClick={handleResendVerification}
                type="button"
              >
                {resending ? "Sending..." : resendStatus === "error" ? "Try again" : "Resend verification email"}
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="hero-card hero-card--dashboard">
        <div>
          <div className="section-label">Workspace summary</div>
          <h2 className="hero-card__title">Workspace command overview</h2>
          <p className="hero-card__body">
            Monitor access posture for <strong>{activeWorkspace?.display_name ?? "your workspace"}</strong> with live
            quota, billing, and operator counts sourced from the hosted control plane.
          </p>
        </div>
        <div className="status-grid">
          <div className="status-card">
            <strong>{activeWorkspace?.tier ?? "free"}</strong>
            <span>workspace tier</span>
          </div>
          <div className="status-card">
            <strong>{user?.role.replace("workspace_", "") ?? "admin"}</strong>
            <span>active role</span>
          </div>
          <div className="status-card">
            <strong>{activeWorkspace?.status ?? "active"}</strong>
            <span>workspace status</span>
          </div>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="content-grid content-grid--quad">
        {[
          {
            icon: ShieldCheck,
            title: "Subscription",
            value: billing?.subscription_status ?? "none",
            copy: billing?.billing_provider
              ? `Recurring billing managed by ${billing.billing_provider}.`
              : "No recurring billing provider is attached yet."
          },
          {
            icon: Bot,
            title: "Agents",
            value: counts ? String(counts.active_agents) : "0",
            copy: quota ? `${quota.agents.used} of ${quota.agents.limit} agent slots currently used.` : "Loading agent quota."
          },
          {
            icon: Users,
            title: "Members",
            value: counts ? String(counts.active_members) : "0",
            copy: quota ? `${quota.members.used} of ${quota.members.limit} member slots currently used.` : "Loading member quota."
          },
          {
            icon: KeyRound,
            title: "Secret requests",
            value: quota ? `${quota.secret_requests.used}/${quota.secret_requests.limit}` : "0/0",
            copy: quota
              ? `Daily quota resets at ${new Date(quota.secret_requests.reset_at * 1000).toLocaleString()}.`
              : "Loading daily quota."
          },
          {
            icon: AlertTriangle,
            title: "A2A exchange",
            value: quota?.a2a_exchange_available ? "Enabled" : "Locked",
            copy: quota?.a2a_exchange_available
              ? "Exchange request creation is available on this workspace tier."
              : "Upgrade billing before agent-to-agent exchange is unlocked."
          },
          {
            icon: BadgeDollarSign,
            title: "Provider",
            value: billing?.billing_provider ?? "none",
            copy: billing?.provider_customer_id
              ? "Workspace billing identity is connected and ready for portal actions."
              : "No customer portal is available until the first subscription is created."
          }
        ].map(({ icon: Icon, title, value, copy }) => (
          <article key={title} className="info-card">
            <div className="info-card__icon">
              <Icon size={18} />
            </div>
            <div className="card-title">{title}</div>
            <div className="metric-value">{value}</div>
            <p className="hero-card__body">{copy}</p>
          </article>
        ))}
      </div>

      {quota ? (
        <div className="section-grid">
          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Quota usage</div>
                <h3 className="panel-card__title">Daily and seat limits</h3>
                <p className="panel-card__body">These counters drive the hosted free-tier guardrails and upgrade path.</p>
              </div>
              <div className="inline-actions">
                <StatusBadge tone={activeWorkspace?.tier === "standard" ? "success" : "warning"}>
                  {`${activeWorkspace?.tier ?? "free"} tier`}
                </StatusBadge>
                <StatusBadge tone={quota.a2a_exchange_available ? "success" : "neutral"}>
                  {quota.a2a_exchange_available ? "exchange enabled" : "exchange locked"}
                </StatusBadge>
              </div>
            </div>

            <div className="quota-grid">
              <QuotaMeter
                helper="Hosted agent secret-request volume for the current UTC day."
                label="Secret requests"
                limit={quota.secret_requests.limit}
                tone={quota.secret_requests.used >= quota.secret_requests.limit ? "danger" : "default"}
                used={quota.secret_requests.used}
              />
              <QuotaMeter
                helper="Active enrolled agents allowed for this workspace tier."
                label="Agents"
                limit={quota.agents.limit}
                tone={quota.agents.used >= quota.agents.limit ? "warning" : "default"}
                used={quota.agents.used}
              />
              <QuotaMeter
                helper="Active human operators and viewers in the workspace."
                label="Members"
                limit={quota.members.limit}
                tone={quota.members.used >= quota.members.limit ? "warning" : "default"}
                used={quota.members.used}
              />
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Billing posture</div>
                <h3 className="panel-card__title">Recurring subscription snapshot</h3>
                <p className="panel-card__body">This surface tracks the workspace subscription provider only. x402 usage lands separately.</p>
              </div>
            </div>

            <div className="detail-list">
              <div className="detail-list__item">
                <div className="meta-label">Provider</div>
                <div className="meta-value">{billing?.billing_provider ?? "Not connected"}</div>
              </div>
              <div className="detail-list__item">
                <div className="meta-label">Subscription status</div>
                <div className="meta-value">{billing?.subscription_status ?? "none"}</div>
              </div>
              <div className="detail-list__item">
                <div className="meta-label">Customer reference</div>
                <div className="meta-value">{billing?.provider_customer_id ?? "Pending checkout"}</div>
              </div>
            </div>

            <div className="inline-actions">
              <button className="ghost-button" onClick={() => void refresh()} type="button">
                Refresh summary
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
