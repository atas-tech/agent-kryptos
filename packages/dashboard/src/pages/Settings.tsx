import { Building2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client.js";
import { useAuth } from "../auth/useAuth.js";
import type { WorkspaceSummary } from "../auth/types.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface WorkspaceResponse {
  workspace: WorkspaceSummary;
}

export function SettingsPage() {
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
      setError(requestError instanceof Error ? requestError.message : "Unable to load workspace settings");
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
      setSuccess("Workspace display name updated.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update workspace");
    } finally {
      setSaving(false);
    }
  }

  const details = workspaceDetails ?? workspace;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="section-label">Desktop Workspace Settings Overview</div>
        <h2 className="hero-card__title">Workspace identity and verification</h2>
        <p className="hero-card__body">
          This page follows the Stitch settings overview pattern: operational metadata stays read-only, while the
          workspace display name remains editable for administrators.
        </p>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Workspace slug</span>
            <strong>{details?.slug ?? "Loading..."}</strong>
          </article>
          <article className="metric-panel">
            <span>Tier</span>
            <strong>{details?.tier ?? "free"}</strong>
          </article>
          <article className="metric-panel">
            <span>Owner verification</span>
            <strong>{details?.owner_email_verified ? "Verified" : "Pending"}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="turnstile-placeholder">{success}</div> : null}

      <div className="section-grid">
        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Workspace profile</div>
              <h3 className="panel-card__title">Edit display name</h3>
              <p className="panel-card__body">Update the operator-facing workspace label used throughout the dashboard shell.</p>
            </div>
          </div>

          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="form-grid form-grid--single">
              <div className="field-stack">
                <label htmlFor="workspace-display-name">Workspace display name</label>
                <input
                  className="dashboard-input"
                  disabled={loading}
                  id="workspace-display-name"
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="My Secure Workspace"
                  required
                  value={displayName}
                  data-testid="workspace-display-name-input"
                />
                <small>Changes here update the header chrome and sidebar workspace labeling immediately after save.</small>
              </div>
            </div>

            <div className="modal-card__actions">
              <button className="primary-button" data-testid="save-workspace-btn" disabled={saving || loading} type="submit">
                {saving ? "Saving..." : "Save workspace"}
              </button>
            </div>
          </form>
        </div>

        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Read-only controls</div>
              <h3 className="panel-card__title">Hosted configuration</h3>
              <p className="panel-card__body">These fields are fixed for Milestone 3 and reflect the hosted platform contract.</p>
            </div>
          </div>

          <div className="detail-list">
            <div className="detail-list__item">
              <div className="meta-label">Workspace slug</div>
              <strong>{details?.slug ?? "Loading..."}</strong>
            </div>
            <div className="detail-list__item">
              <div className="meta-label">Tier</div>
              <strong>{details?.tier ?? "free"}</strong>
            </div>
            <div className="detail-list__item">
              <div className="meta-label">Status</div>
              <strong>{details?.status ?? "active"}</strong>
            </div>
            <div className="detail-list__item">
              <div className="meta-label">Created</div>
              <strong>{details?.created_at ? new Date(details.created_at).toLocaleDateString() : "Loading..."}</strong>
            </div>
          </div>

          <div className="panel-card__stack">
            <div className="turnstile-placeholder">
              <Building2 size={18} />
              <div>
                <strong>Owner verification status</strong>
                <span>
                  {details?.owner_email_verified
                    ? "The workspace owner email is verified. Enrollment, member creation, and billing actions stay unlocked."
                    : "The workspace owner email is not verified yet. Higher-risk hosted actions remain gated until verification completes."}
                </span>
              </div>
            </div>

            <div className="inline-actions">
              <StatusBadge tone={details?.owner_email_verified ? "success" : "warning"}>
                {details?.owner_email_verified ? "owner verified" : "verification pending"}
              </StatusBadge>
              <StatusBadge tone="neutral">{details?.status ?? "active"}</StatusBadge>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
