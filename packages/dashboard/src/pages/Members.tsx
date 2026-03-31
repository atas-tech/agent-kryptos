import { ShieldAlert, UserPlus, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "../api/client.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DataTable } from "../components/DataTable.js";
import { EmptyState } from "../components/EmptyState.js";
import { StatusBadge } from "../components/StatusBadge.js";
import type { UserRole } from "../auth/types.js";

interface MemberRecord {
  id: string;
  email: string;
  role: UserRole;
  status: "active" | "suspended" | "deleted";
  email_verified: boolean;
  force_password_change: boolean;
  created_at: string;
  updated_at: string;
}

interface MembersResponse {
  members: MemberRecord[];
  next_cursor: string | null;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

const WEAK_TEMPORARY_PASSWORDS = new Set(["password123", "password123!", "changeme123", "temporary123"]);

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function toneForMemberStatus(status: MemberRecord["status"]): "success" | "warning" | "neutral" {
  if (status === "active") {
    return "success";
  }

  if (status === "suspended") {
    return "warning";
  }

  return "neutral";
}

function describePasswordStrength(value: string): { key: "waiting" | "tooWeak" | "tooShort" | "acceptable" | "strong" | "veryStrong"; percent: number; valid: boolean } {
  if (value.length === 0) {
    return { key: "waiting", percent: 0, valid: false };
  }

  const normalized = value.trim().toLowerCase();
  if (WEAK_TEMPORARY_PASSWORDS.has(normalized)) {
    return { key: "tooWeak", percent: 12, valid: false };
  }

  const checks = [
    value.length >= 12,
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value)
  ];
  const score = checks.filter(Boolean).length;

  if (value.length < 12) {
    return { key: "tooShort", percent: 20, valid: false };
  }

  if (score <= 3) {
    return { key: "acceptable", percent: 58, valid: true };
  }

  if (score === 4) {
    return { key: "strong", percent: 78, valid: true };
  }

  return { key: "veryStrong", percent: 100, valid: true };
}

export function MembersPage() {
  const { t } = useTranslation(["members", "common"]);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended">("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  const [formPending, setFormPending] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("workspace_viewer");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [confirmSuspend, setConfirmSuspend] = useState<MemberRecord | null>(null);
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);
  const [activeAdminIds, setActiveAdminIds] = useState<Set<string>>(new Set());
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const passwordStrength = describePasswordStrength(temporaryPassword);

  useEffect(() => {
    void loadMembers(true);
    void refreshActiveAdmins();
  }, [statusFilter]);

  async function loadMembers(reset = false): Promise<void> {
    if (reset) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams();
      params.set("limit", "10");
      if (!reset && nextCursor) {
        params.set("cursor", nextCursor);
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }

      const payload = await apiRequest<MembersResponse>(`/api/v2/members?${params.toString()}`);
      setMembers((current) => {
        if (reset) {
          return payload.members;
        }

        const existingIds = new Set(current.map((member) => member.id));
        return current.concat(payload.members.filter((member) => !existingIds.has(member.id)));
      });
      setNextCursor(payload.next_cursor);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("members:errors.loadFailed"));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function refreshActiveAdmins(): Promise<void> {
    try {
      let cursor: string | null = null;
      const admins = new Set<string>();

      do {
        const params = new URLSearchParams({
          limit: "100",
          status: "active"
        });
        if (cursor) {
          params.set("cursor", cursor);
        }

        const payload = await apiRequest<MembersResponse>(`/api/v2/members?${params.toString()}`);
        for (const member of payload.members) {
          if (member.role === "workspace_admin") {
            admins.add(member.id);
          }
        }
        cursor = payload.next_cursor;
      } while (cursor);

      setActiveAdminIds(admins);
    } catch {
      setActiveAdminIds(new Set());
    }
  }

  function isLastAdmin(member: MemberRecord): boolean {
    return member.role === "workspace_admin" && member.status === "active" && activeAdminIds.size === 1 && activeAdminIds.has(member.id);
  }

  async function handleCreateMember(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!passwordStrength.valid) {
      setError(t("members:errors.weakPassword"));
      return;
    }

    setFormPending(true);
    try {
      await apiRequest<{ member: MemberRecord }>("/api/v2/members", {
        method: "POST",
        body: JSON.stringify({
          email,
          role,
          temporary_password: temporaryPassword
        })
      });

      setShowAddMember(false);
      setEmail("");
      setRole("workspace_viewer");
      setTemporaryPassword("");
      await Promise.all([loadMembers(true), refreshActiveAdmins()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("members:errors.createFailed"));
    } finally {
      setFormPending(false);
    }
  }

  async function updateMember(memberId: string, payload: { role?: UserRole; status?: "active" | "suspended" }): Promise<void> {
    setActionPendingId(memberId);
    setError(null);

    try {
      await apiRequest<{ member: MemberRecord }>(`/api/v2/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      setConfirmSuspend(null);
      setSuccessMessage(payload.role ? t("members:status.roleUpdated") : t("members:status.statusUpdated"));
      setTimeout(() => setSuccessMessage(null), 3000);
      await Promise.all([loadMembers(true), refreshActiveAdmins()]);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "last_admin_lockout") {
        setError(t("members:status.lastAdminError"));
      } else {
        setError(requestError instanceof Error ? requestError.message : t("members:errors.updateFailed"));
      }
    } finally {
      setActionPendingId(null);
    }
  }

  const activeCount = members.filter((member) => member.status === "active").length;
  const suspendedCount = members.filter((member) => member.status === "suspended").length;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">{t("members:hero.sectionLabel")}</div>
            <h2 className="hero-card__title" data-testid="members-title">{t("members:hero.title")}</h2>
            <p className="hero-card__body">{t("members:hero.body")}</p>
          </div>

          <div className="toolbar__actions">
            <button className="primary-button" data-testid="add-member-btn" onClick={() => setShowAddMember(true)} type="button">
              <UserPlus size={16} />
              {t("members:actions.addMember")}
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("members:stats.activeMembers")}</span>
            <strong data-testid="active-members-count">{activeCount}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("members:stats.suspendedMembers")}</span>
            <strong data-testid="suspended-members-count">{suspendedCount}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("members:stats.adminSafety")}</span>
            <strong data-testid="admin-safety-count">{t(activeAdminIds.size === 1 ? "members:stats.activeAdmin" : "members:stats.activeAdmins", { count: activeAdminIds.size })}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {successMessage ? <div className="success-banner" data-testid="members-success-banner">{successMessage}</div> : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">{t("members:table.sectionLabel")}</div>
            <h3 className="panel-card__title">{t("members:table.title")}</h3>
            <p className="panel-card__body">{t("members:table.body")}</p>
          </div>

          <div className="toolbar__filters">
            <select
              aria-label={t("members:filter.label")}
              className="dashboard-select"
              data-testid="members-status-filter"
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              value={statusFilter}
            >
              <option value="all">{t("common:allStatuses")}</option>
              <option value="active">{t("common:activeOnly")}</option>
              <option value="suspended">{t("common:suspendedOnly")}</option>
            </select>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "member",
              header: t("members:table.columnMember"),
              render: (member) => (
                <div data-testid={`member-row-${member.email}`}>
                  <div className="record-title" data-testid="member-email-cell">{member.email}</div>
                  <div className="record-meta">
                    {t("members:status.added", { date: formatDate(member.created_at) })} · {member.email_verified ? t("common:verified") : t("common:unverified")}
                  </div>
                </div>
              )
            },
            {
              key: "role",
              header: t("members:table.columnRole"),
              render: (member) => (
                <select
                  aria-label={t("members:table.roleFor", { email: member.email })}
                  className="inline-select"
                  data-testid={`role-select-${member.email}`}
                  disabled={actionPendingId === member.id || isLastAdmin(member)}
                  onChange={(event) => void updateMember(member.id, { role: event.target.value as UserRole })}
                  value={member.role}
                >
                  <option value="workspace_admin">{t("members:roles.workspace_admin")}</option>
                  <option value="workspace_operator">{t("members:roles.workspace_operator")}</option>
                  <option value="workspace_viewer">{t("members:roles.workspace_viewer")}</option>
                </select>
              )
            },
            {
              key: "status",
              header: t("members:table.columnStatus"),
              render: (member) => (
                <div>
                  <StatusBadge data-testid={`member-status-${member.email}`} tone={toneForMemberStatus(member.status)}>
                    {t(`common:${member.status}`)}
                  </StatusBadge>
                  {member.force_password_change ? <div className="record-meta">{t("members:status.passwordResetRequired")}</div> : null}
                </div>
              )
            },
            {
              key: "actions",
              header: t("members:table.columnActions"),
              render: (member) => (
                <div className="inline-actions">
                  <button
                    className="ghost-button"
                    disabled={member.status !== "active" || actionPendingId === member.id || isLastAdmin(member)}
                    onClick={() => setConfirmSuspend(member)}
                    type="button"
                    data-testid={`suspend-btn-${member.email}`}
                  >
                    <ShieldAlert size={16} />
                    {t("members:actions.suspend")}
                  </button>
                </div>
              )
            }
          ]}
          emptyState={
            <EmptyState
              action={
                <button className="primary-button" data-testid="add-first-member-btn" onClick={() => setShowAddMember(true)} type="button">
                  <UserPlus size={16} />
                  {t("members:addMember.addFirstMember")}
                </button>
              }
              body={t("members:emptyState.body")}
              title={t("members:emptyState.title")}
            />
          }
          footer={
            <>
              <span className="helper-copy" data-testid="members-count-footer">
                {loading ? t("members:footer.loadingMembers") : t("common:rowsLoaded", { count: members.length })}
              </span>
              <button className="ghost-button" data-testid="load-more-members-btn" disabled={!nextCursor || loadingMore} onClick={() => void loadMembers()} type="button">
                {loadingMore ? t("common:loading") : nextCursor ? t("common:loadMore") : t("common:noMoreRows")}
              </button>
            </>
          }
          loading={loading}
          rowKey={(member) => member.id}
          rows={members}
        />
      </div>

      {showAddMember ? (
        <div className="modal-shell" role="dialog" aria-modal="true" aria-label={t("members:actions.addMember")}>
          <button aria-label={t("common:close")} className="modal-shell__backdrop" onClick={() => setShowAddMember(false)} type="button" />
          <div className="modal-card">
            <div className="modal-card__header">
              <div className="brand-mark">
                <Users size={18} />
              </div>
              <div>
                <div className="section-label">{t("members:addMember.sectionLabel")}</div>
                <h2 className="modal-card__title">{t("members:addMember.title")}</h2>
              </div>
            </div>

            <p className="modal-card__body">{t("members:addMember.body")}</p>

            <form onSubmit={(event) => void handleCreateMember(event)}>
              <div className="form-grid">
                <div className="field-stack">
                  <label htmlFor="member-email">{t("members:addMember.emailLabel")}</label>
                  <input
                    className="dashboard-input"
                    data-testid="add-member-email-input"
                    id="member-email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={t("members:addMember.emailPlaceholder")}
                    required
                    type="email"
                    value={email}
                  />
                  <small>{t("members:addMember.emailHint")}</small>
                </div>

                <div className="field-stack">
                  <label htmlFor="member-role">{t("members:addMember.roleLabel")}</label>
                  <select
                    className="dashboard-select"
                    data-testid="add-member-role-select"
                    id="member-role"
                    onChange={(event) => setRole(event.target.value as UserRole)}
                    value={role}
                  >
                    <option value="workspace_viewer">{t("members:roles.workspace_viewer")}</option>
                    <option value="workspace_operator">{t("members:roles.workspace_operator")}</option>
                    <option value="workspace_admin">{t("members:roles.workspace_admin")}</option>
                  </select>
                  <small>{t("members:addMember.roleHint")}</small>
                </div>
              </div>

              <div className="form-grid form-grid--single">
                <div className="field-stack">
                  <label htmlFor="temporary-password">{t("members:addMember.tempPasswordLabel")}</label>
                  <input
                    className="dashboard-input"
                    data-testid="add-member-password-input"
                    id="temporary-password"
                    minLength={12}
                    onChange={(event) => setTemporaryPassword(event.target.value)}
                    placeholder={t("members:addMember.tempPasswordPlaceholder")}
                    required
                    value={temporaryPassword}
                  />
                  <div className="strength-meter">
                    <span style={{ width: `${passwordStrength.percent}%` }} />
                  </div>
                  <div className="strength-copy" data-testid="password-strength-label">
                    {t("members:addMember.tempPasswordStrength", { label: t(`members:passwordStrength.${passwordStrength.key}`) })}
                  </div>
                </div>
              </div>

              <div className="modal-card__actions">
                <button className="ghost-button" data-testid="add-member-cancel" onClick={() => setShowAddMember(false)} type="button">
                  {t("common:cancel")}
                </button>
                <button className="primary-button" data-testid="add-member-submit" disabled={formPending} type="submit">
                  {formPending ? t("members:addMember.submitting") : t("members:addMember.submitButton")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        body={
          confirmSuspend
            ? t("members:actions.suspendBody", { email: confirmSuspend.email })
            : ""
        }
        confirmLabel={t("members:actions.suspendLabel")}
        onCancel={() => setConfirmSuspend(null)}
        onConfirm={() => (confirmSuspend ? void updateMember(confirmSuspend.id, { status: "suspended" }) : undefined)}
        open={Boolean(confirmSuspend)}
        pending={actionPendingId === confirmSuspend?.id}
        title={confirmSuspend ? t("members:actions.suspendTitle", { email: confirmSuspend.email }) : t("members:actions.suspendLabel")}
      />
    </section>
  );
}
