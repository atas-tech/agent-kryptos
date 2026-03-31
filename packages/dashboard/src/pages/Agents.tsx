import { Bot, KeyRound, Plus, RefreshCw, ShieldBan } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../api/client.js";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { DataTable } from "../components/DataTable.js";
import { EmptyState } from "../components/EmptyState.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface AgentRecord {
  id: string;
  agent_id: string;
  display_name: string | null;
  status: "active" | "revoked" | "deleted";
  created_at: string;
  revoked_at: string | null;
}

interface AgentsResponse {
  agents: AgentRecord[];
  next_cursor: string | null;
}

interface AgentMutationResponse {
  agent: AgentRecord;
  bootstrap_api_key?: string;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function toneForStatus(status: AgentRecord["status"]): "success" | "warning" | "neutral" {
  if (status === "active") {
    return "success";
  }

  if (status === "revoked") {
    return "warning";
  }

  return "neutral";
}

export function AgentsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "revoked">("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [formPending, setFormPending] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [confirmAction, setConfirmAction] = useState<{ type: "rotate" | "revoke"; agent: AgentRecord } | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [revealedKey, setRevealedKey] = useState<{ apiKey: string; title: string; description: string } | null>(null);

  useEffect(() => {
    void loadAgents(true);
  }, [statusFilter]);

  async function loadAgents(reset = false): Promise<void> {
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

      const payload = await apiRequest<AgentsResponse>(`/api/v2/agents?${params.toString()}`);
      setAgents((current) => {
        if (reset) {
          return payload.agents;
        }

        const existingIds = new Set(current.map((agent) => agent.id));
        return current.concat(payload.agents.filter((agent) => !existingIds.has(agent.id)));
      });
      setNextCursor(payload.next_cursor);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("agents:errors.loadFailed"));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function handleEnroll(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormPending(true);
    setError(null);

    try {
      const payload = await apiRequest<AgentMutationResponse>("/api/v2/agents", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          display_name: displayName || undefined
        })
      });

      setShowEnroll(false);
      setAgentId("");
      setDisplayName("");
      if (payload.bootstrap_api_key) {
        setRevealedKey({
          apiKey: payload.bootstrap_api_key,
          title: t("agents:reveal.bootstrapTitle", { agentId: payload.agent.agent_id }),
          description: t("agents:reveal.bootstrapDescription")
        });
      }
      await loadAgents(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("agents:errors.enrollFailed"));
    } finally {
      setFormPending(false);
    }
  }

  async function handleConfirmAction(): Promise<void> {
    if (!confirmAction) {
      return;
    }

    setActionPending(true);
    setError(null);

    try {
      if (confirmAction.type === "rotate") {
        const payload = await apiRequest<AgentMutationResponse>(
          `/api/v2/agents/${encodeURIComponent(confirmAction.agent.agent_id)}/rotate-key`,
          { method: "POST" }
        );

        if (payload.bootstrap_api_key) {
          setRevealedKey({
            apiKey: payload.bootstrap_api_key,
            title: t("agents:reveal.replacementTitle", { agentId: payload.agent.agent_id }),
            description: t("agents:reveal.replacementDescription")
          });
        }
      } else {
        await apiRequest<AgentMutationResponse>(`/api/v2/agents/${encodeURIComponent(confirmAction.agent.agent_id)}`, {
          method: "DELETE"
        });
      }

      setConfirmAction(null);
      await loadAgents(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("agents:errors.updateFailed"));
    } finally {
      setActionPending(false);
    }
  }

  const activeCount = agents.filter((agent) => agent.status === "active").length;
  const revokedCount = agents.filter((agent) => agent.status === "revoked").length;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">{t("agents:hero.sectionLabel")}</div>
            <h2 className="hero-card__title">{t("agents:hero.title")}</h2>
            <p className="hero-card__body">{t("agents:hero.body")}</p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" data-testid="refresh-agents-btn" onClick={() => void loadAgents(true)} type="button">
              <RefreshCw size={16} />
              {t("common:refresh")}
            </button>
            <button className="primary-button" data-testid="enroll-agent-btn" onClick={() => setShowEnroll(true)} type="button">
              <Plus size={16} />
              {t("agents:actions.enroll")}
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("agents:stats.activeAgents")}</span>
            <strong data-testid="active-agents-count">{activeCount}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("agents:stats.revokedAgents")}</span>
            <strong data-testid="revoked-agents-count">{revokedCount}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("agents:stats.revealPolicy")}</span>
            <strong>{t("agents:stats.revealPolicyValue")}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">{t("agents:table.sectionLabel")}</div>
            <h3 className="panel-card__title">{t("agents:table.title")}</h3>
            <p className="panel-card__body">{t("agents:table.body")}</p>
          </div>

          <div className="toolbar__filters">
            <select
              aria-label={t("agents:filter.label")}
              className="dashboard-select"
              data-testid="agents-status-filter"
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              value={statusFilter}
            >
              <option value="all">{t("common:allStatuses")}</option>
              <option value="active">{t("common:activeOnly")}</option>
              <option value="revoked">{t("common:revokedOnly")}</option>
            </select>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "agent",
              header: t("agents:table.columnAgent"),
              render: (agent) => (
                <div data-testid={`agent-row-${agent.agent_id}`}>
                  <div className="record-title" data-testid="agent-id-cell">{agent.agent_id}</div>
                  <div className="record-meta">{agent.display_name ?? t("common:noDisplayName")}</div>
                </div>
              )
            },
            {
              key: "status",
              header: t("agents:table.columnStatus"),
              render: (agent) => <StatusBadge data-testid={`agent-status-${agent.agent_id}`} tone={toneForStatus(agent.status)}>{t(`common:${agent.status}`)}</StatusBadge>
            },
            {
              key: "created",
              header: t("agents:table.columnCreated"),
              render: (agent) => (
                <div>
                  <div className="record-title">{formatDate(agent.created_at)}</div>
                  <div className="record-meta">
                    {agent.revoked_at ? t("agents:dates.revokedAt", { date: formatDate(agent.revoked_at) }) : t("common:ready")}
                  </div>
                </div>
              )
            },
            {
              key: "actions",
              header: t("agents:table.columnActions"),
              render: (agent) => (
                <div className="inline-actions">
                  <button
                    className="ghost-button"
                    data-testid={`rotate-agent-btn-${agent.agent_id}`}
                    disabled={agent.status !== "active"}
                    onClick={() => setConfirmAction({ type: "rotate", agent })}
                    type="button"
                  >
                    <KeyRound size={16} />
                    {t("agents:actions.rotate")}
                  </button>
                  <button
                    className="ghost-button"
                    data-testid={`revoke-agent-btn-${agent.agent_id}`}
                    disabled={agent.status !== "active"}
                    onClick={() => setConfirmAction({ type: "revoke", agent })}
                    type="button"
                  >
                    <ShieldBan size={16} />
                    {t("agents:actions.revoke")}
                  </button>
                </div>
              )
            }
          ]}
          emptyState={
            <EmptyState
              action={
                <button className="primary-button" data-testid="enroll-first-agent-btn" onClick={() => setShowEnroll(true)} type="button">
                  <Plus size={16} />
                  {t("agents:enroll.enrollFirstAgent")}
                </button>
              }
              body={t("agents:emptyState.body")}
              title={t("agents:emptyState.title")}
            />
          }
          footer={
            <>
              <span className="helper-copy" data-testid="agents-count-footer">
                {loading ? t("agents:footer.loadingAgents") : t("common:rowsLoaded", { count: agents.length })}
              </span>
              <button className="ghost-button" data-testid="load-more-agents-btn" disabled={!nextCursor || loadingMore} onClick={() => void loadAgents()} type="button">
                {loadingMore ? t("common:loading") : nextCursor ? t("common:loadMore") : t("common:noMoreRows")}
              </button>
            </>
          }
          loading={loading}
          rowKey={(agent) => agent.id}
          rows={agents}
        />
      </div>

      {showEnroll ? (
        <div className="modal-shell" role="dialog" aria-modal="true" aria-label={t("agents:enroll.title")}>
          <button aria-label={t("common:close")} className="modal-shell__backdrop" onClick={() => setShowEnroll(false)} type="button" />
          <div className="modal-card">
            <div className="modal-card__header">
              <div className="brand-mark">
                <Bot size={18} />
              </div>
              <div>
                <div className="section-label">{t("agents:enroll.sectionLabel")}</div>
                <h2 className="modal-card__title">{t("agents:enroll.title")}</h2>
              </div>
            </div>

            <p className="modal-card__body">{t("agents:enroll.body")}</p>

            <form onSubmit={(event) => void handleEnroll(event)}>
              <div className="form-grid">
                <div className="field-stack">
                  <label htmlFor="agent-id">{t("agents:enroll.agentIdLabel")}</label>
                  <input
                    className="dashboard-input"
                    data-testid="enroll-agent-id-input"
                    id="agent-id"
                    onChange={(event) => setAgentId(event.target.value)}
                    placeholder={t("agents:enroll.agentIdPlaceholder")}
                    required
                    value={agentId}
                  />
                  <small>{t("agents:enroll.agentIdHint")}</small>
                </div>

                <div className="field-stack">
                  <label htmlFor="agent-display-name">{t("agents:enroll.displayNameLabel")}</label>
                  <input
                    className="dashboard-input"
                    data-testid="enroll-agent-display-name-input"
                    id="agent-display-name"
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={t("agents:enroll.displayNamePlaceholder")}
                    value={displayName}
                  />
                  <small>{t("agents:enroll.displayNameHint")}</small>
                </div>
              </div>

              <div className="modal-card__actions">
                <button className="ghost-button" data-testid="enroll-agent-cancel" onClick={() => setShowEnroll(false)} type="button">
                  {t("common:cancel")}
                </button>
                <button className="primary-button" data-testid="enroll-agent-submit" disabled={formPending} type="submit">
                  {formPending ? t("agents:enroll.submitting") : t("agents:enroll.submitButton")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        body={
          confirmAction?.type === "rotate"
            ? t("agents:confirm.rotateBody", { agentId: confirmAction.agent.agent_id })
            : t("agents:confirm.revokeBody", { agentId: confirmAction?.agent.agent_id ?? "" })
        }
        confirmLabel={confirmAction?.type === "rotate" ? t("agents:confirm.rotateLabel") : t("agents:confirm.revokeLabel")}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => void handleConfirmAction()}
        open={Boolean(confirmAction)}
        pending={actionPending}
        title={confirmAction?.type === "rotate" ? t("agents:confirm.rotateTitle") : t("agents:confirm.revokeTitle")}
      />

      <ApiKeyReveal
        apiKey={revealedKey?.apiKey ?? ""}
        description={revealedKey?.description ?? ""}
        onClose={() => setRevealedKey(null)}
        open={Boolean(revealedKey)}
        title={revealedKey?.title ?? ""}
      />
    </section>
  );
}
