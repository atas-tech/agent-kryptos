import { ShieldAlert, UserPlus, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
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

function describePasswordStrength(value: string): { label: string; percent: number; valid: boolean } {
  if (value.length === 0) {
    return { label: "waiting for input", percent: 0, valid: false };
  }

  const normalized = value.trim().toLowerCase();
  if (WEAK_TEMPORARY_PASSWORDS.has(normalized)) {
    return { label: "too weak", percent: 12, valid: false };
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
    return { label: "too short", percent: 20, valid: false };
  }

  if (score <= 3) {
    return { label: "acceptable", percent: 58, valid: true };
  }

  if (score === 4) {
    return { label: "strong", percent: 78, valid: true };
  }

  return { label: "very strong", percent: 100, valid: true };
}

export function MembersPage() {
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
      setError(requestError instanceof Error ? requestError.message : "Unable to load members");
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
      setError("Temporary password must be at least 12 characters and not obviously weak.");
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
      setError(requestError instanceof Error ? requestError.message : "Unable to create member");
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
      await Promise.all([loadMembers(true), refreshActiveAdmins()]);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "last_admin_lockout") {
        setError("The last active admin cannot be demoted or suspended.");
      } else {
        setError(requestError instanceof Error ? requestError.message : "Unable to update member");
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
            <div className="section-label">Milestone 3</div>
            <h2 className="hero-card__title">Workspace member controls</h2>
            <p className="hero-card__body">
              Manage human access from the Stitch member-management layout: create users with temporary passwords,
              change roles inline, and protect the final active admin from accidental lockout.
            </p>
          </div>

          <div className="toolbar__actions">
            <button className="primary-button" onClick={() => setShowAddMember(true)} type="button">
              <UserPlus size={16} />
              Add member
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Active members</span>
            <strong>{activeCount}</strong>
          </article>
          <article className="metric-panel">
            <span>Suspended members</span>
            <strong>{suspendedCount}</strong>
          </article>
          <article className="metric-panel">
            <span>Admin safety</span>
            <strong>{activeAdminIds.size} active admin{activeAdminIds.size === 1 ? "" : "s"}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">Desktop Members Management</div>
            <h3 className="panel-card__title">Human access roster</h3>
            <p className="panel-card__body">
              Roles update inline to match the Stitch table treatment, while suspension stays behind confirmation.
            </p>
          </div>

          <div className="toolbar__filters">
            <select
              aria-label="Filter members by status"
              className="dashboard-select"
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              value={statusFilter}
            >
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="suspended">Suspended only</option>
            </select>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "member",
              header: "Member",
              render: (member) => (
                <div>
                  <div className="record-title">{member.email}</div>
                  <div className="record-meta">
                    Added {formatDate(member.created_at)} · {member.email_verified ? "verified" : "unverified"}
                  </div>
                </div>
              )
            },
            {
              key: "role",
              header: "Role",
              render: (member) => (
                <select
                  aria-label={`Role for ${member.email}`}
                  className="inline-select"
                  data-testid={`role-select-${member.email}`}
                  disabled={actionPendingId === member.id || isLastAdmin(member)}
                  onChange={(event) => void updateMember(member.id, { role: event.target.value as UserRole })}
                  value={member.role}
                >
                  <option value="workspace_admin">Workspace admin</option>
                  <option value="workspace_operator">Workspace operator</option>
                  <option value="workspace_viewer">Workspace viewer</option>
                </select>
              )
            },
            {
              key: "status",
              header: "Status",
              render: (member) => (
                <div>
                  <StatusBadge data-testid={`member-status-${member.email}`} tone={toneForMemberStatus(member.status)}>{member.status}</StatusBadge>
                  {member.force_password_change ? <div className="record-meta">Password reset required</div> : null}
                </div>
              )
            },
            {
              key: "actions",
              header: "Actions",
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
                    Suspend
                  </button>
                </div>
              )
            }
          ]}
          emptyState={
            <EmptyState
              action={
                <button className="primary-button" onClick={() => setShowAddMember(true)} type="button">
                  <UserPlus size={16} />
                  Add first member
                </button>
              }
              body="This workspace only has the owner account. Add operators or viewers to distribute access."
              title="No members yet"
            />
          }
          footer={
            <>
              <span className="helper-copy">{loading ? "Loading members..." : `${members.length} rows loaded`}</span>
              <button className="ghost-button" disabled={!nextCursor || loadingMore} onClick={() => void loadMembers()} type="button">
                {loadingMore ? "Loading..." : nextCursor ? "Load more" : "No more rows"}
              </button>
            </>
          }
          loading={loading}
          rowKey={(member) => member.id}
          rows={members}
        />
      </div>

      {showAddMember ? (
        <div className="modal-shell" role="dialog" aria-modal="true" aria-label="Add member">
          <button aria-label="Close dialog" className="modal-shell__backdrop" onClick={() => setShowAddMember(false)} type="button" />
          <div className="modal-card">
            <div className="modal-card__header">
              <div className="brand-mark">
                <Users size={18} />
              </div>
              <div>
                <div className="section-label">Member onboarding</div>
                <h2 className="modal-card__title">Create workspace member</h2>
              </div>
            </div>

            <p className="modal-card__body">
              Provision a user with a temporary password. The first login will redirect them into the password change
              flow automatically.
            </p>

            <form onSubmit={(event) => void handleCreateMember(event)}>
              <div className="form-grid">
                <div className="field-stack">
                  <label htmlFor="member-email">Email address</label>
                  <input
                    className="dashboard-input"
                    id="member-email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="operator@company.com"
                    required
                    type="email"
                    value={email}
                  />
                  <small>Each user belongs to this workspace only in Phase 3A/3B.</small>
                </div>

                <div className="field-stack">
                  <label htmlFor="member-role">Role</label>
                  <select
                    className="dashboard-select"
                    id="member-role"
                    onChange={(event) => setRole(event.target.value as UserRole)}
                    value={role}
                  >
                    <option value="workspace_viewer">Workspace viewer</option>
                    <option value="workspace_operator">Workspace operator</option>
                    <option value="workspace_admin">Workspace admin</option>
                  </select>
                  <small>Admins can manage billing, settings, members, and agent enrollment.</small>
                </div>
              </div>

              <div className="form-grid form-grid--single">
                <div className="field-stack">
                  <label htmlFor="temporary-password">Temporary password</label>
                  <input
                    className="dashboard-input"
                    id="temporary-password"
                    minLength={12}
                    onChange={(event) => setTemporaryPassword(event.target.value)}
                    placeholder="At least 12 characters"
                    required
                    value={temporaryPassword}
                  />
                  <div className="strength-meter">
                    <span style={{ width: `${passwordStrength.percent}%` }} />
                  </div>
                  <div className="strength-copy">Temporary password strength: {passwordStrength.label}</div>
                </div>
              </div>

              <div className="modal-card__actions">
                <button className="ghost-button" onClick={() => setShowAddMember(false)} type="button">
                  Cancel
                </button>
                <button className="primary-button" disabled={formPending} type="submit">
                  {formPending ? "Creating..." : "Create member"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        body={
          confirmSuspend
            ? `Suspend ${confirmSuspend.email}. They will lose access until an admin reactivates the account via API or a future UI flow.`
            : ""
        }
        confirmLabel="Suspend member"
        onCancel={() => setConfirmSuspend(null)}
        onConfirm={() => (confirmSuspend ? void updateMember(confirmSuspend.id, { status: "suspended" }) : undefined)}
        open={Boolean(confirmSuspend)}
        pending={actionPendingId === confirmSuspend?.id}
        title={confirmSuspend ? `Suspend ${confirmSuspend.email}` : "Suspend member"}
      />
    </section>
  );
}
