import { Building2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import type { WorkspaceSummary } from "../auth/types.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface WorkspaceResponse {
  workspace: WorkspaceSummary;
}

export function SettingsPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { workspace, setWorkspaceSummary } = useAuth();
  const [workspaceDetails, setWorkspaceDetails] = useState<WorkspaceSummary | null>(workspace);
  const [displayName, setDisplayName] = useState(workspace?.display_name ?? "");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void loadWorkspace();
  }, []);

  async function loadWorkspace(): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const payload = await apiRequest<WorkspaceResponse>("/api/v2/workspace");
      setWorkspaceDetails(payload.workspace);
      setDisplayName(payload.workspace.display_name);
      setWorkspaceSummary(payload.workspace);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("settings:errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = await apiRequest<WorkspaceResponse>("/api/v2/workspace", {
        method: "PATCH",
        body: JSON.stringify({
          display_name: displayName
        })
      });

      setWorkspaceDetails(payload.workspace);
      setWorkspaceSummary(payload.workspace);
      setSuccess(t("settings:displayName.successMessage"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("settings:errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const details = workspaceDetails ?? workspace;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="section-label">{t("settings:hero.sectionLabel")}</div>
        <h2 className="hero-card__title">{t("settings:hero.title")}</h2>
        <p className="hero-card__body">{t("settings:hero.body")}</p>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("settings:readOnly.slug")}</span>
            <strong>{details?.slug ?? t("common:loading")}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("settings:readOnly.tier")}</span>
            <strong>{details?.tier ?? "free"}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("settings:hero.ownerVerification")}</span>
            <strong>{details?.owner_email_verified ? t("settings:hero.verified") : t("settings:hero.pending")}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="turnstile-placeholder">{success}</div> : null}

      <div className="section-grid">
        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("settings:displayName.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("settings:displayName.title")}</h3>
              <p className="panel-card__body">{t("settings:displayName.body")}</p>
            </div>
          </div>

          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="form-grid form-grid--single">
              <div className="field-stack">
                <label htmlFor="workspace-display-name">{t("settings:displayName.label")}</label>
                <input
                  className="dashboard-input"
                  disabled={loading}
                  id="workspace-display-name"
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={t("settings:displayName.placeholder")}
                  required
                  value={displayName}
                  data-testid="workspace-display-name-input"
                />
                <small>{t("settings:displayName.helper")}</small>
              </div>
            </div>

            <div className="modal-card__actions">
              <button className="primary-button" data-testid="save-workspace-btn" disabled={saving || loading} type="submit">
                {saving ? t("settings:displayName.submitting") : t("settings:displayName.submitButton")}
              </button>
            </div>
          </form>
        </div>

        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("settings:readOnly.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("settings:readOnly.title")}</h3>
              <p className="panel-card__body">{t("settings:readOnly.body")}</p>
            </div>
          </div>

          <div className="detail-list">
            <div className="detail-list__item">
              <div className="meta-label">{t("settings:readOnly.slug")}</div>
              <strong>{details?.slug ?? t("common:loading")}</strong>
            </div>
            <div className="detail-list__item">
              <div className="meta-label">{t("settings:readOnly.tier")}</div>
              <strong>{details?.tier ?? "free"}</strong>
            </div>
            <div className="detail-list__item">
              <div className="meta-label">{t("settings:readOnly.status")}</div>
              <strong>{details?.status ?? "active"}</strong>
            </div>
            <div className="detail-list__item">
              <div className="meta-label">{t("settings:readOnly.createdAt")}</div>
              <strong>{details?.created_at ? new Date(details.created_at).toLocaleDateString(i18n.language) : t("common:loading")}</strong>
            </div>
          </div>

          <div className="panel-card__stack">
            <div className="turnstile-placeholder">
              <Building2 size={18} />
              <div>
                <strong>{t("settings:readOnly.verificationTitle")}</strong>
                <span>
                  {details?.owner_email_verified
                    ? t("settings:readOnly.verifiedBody")
                    : t("settings:readOnly.pendingBody")}
                </span>
              </div>
            </div>

            <div className="inline-actions">
              <StatusBadge tone={details?.owner_email_verified ? "success" : "warning"}>
                {details?.owner_email_verified ? t("settings:readOnly.badgeVerified") : t("settings:readOnly.badgePending")}
              </StatusBadge>
              <StatusBadge tone="neutral">{details?.status ?? "active"}</StatusBadge>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
