import { Bot, KeyRound, Plus, RefreshCw, ShieldBan } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
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
      setError(requestError instanceof Error ? requestError.message : "Unable to load agents");
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
          title: `Bootstrap key for ${payload.agent.agent_id}`,
          description: "Store this API key in the agent runtime now. BlindPass will not reveal it again after dismissal."
        });
      }
      await loadAgents(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to enroll agent");
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
            title: `Replacement key for ${payload.agent.agent_id}`,
            description: "The previous key is now invalid. Store this replacement key before you close the reveal."
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
      setError(requestError instanceof Error ? requestError.message : "Unable to update agent");
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
            <div className="section-label">Milestone 3</div>
            <h2 className="hero-card__title">Agent enrollment and rotation</h2>
            <p className="hero-card__body">
              Manage bootstrap credentials from the Stitch-designed operations grid. Keys are revealed once, rotations
              invalidate prior credentials immediately, and revocations are routed through explicit confirmation.
            </p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => void loadAgents(true)} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
            <button className="primary-button" onClick={() => setShowEnroll(true)} type="button">
              <Plus size={16} />
              Enroll agent
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Active agents</span>
            <strong>{activeCount}</strong>
          </article>
          <article className="metric-panel">
            <span>Revoked agents</span>
            <strong>{revokedCount}</strong>
          </article>
          <article className="metric-panel">
            <span>Reveal policy</span>
            <strong>One-time only</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">Desktop Agents Management</div>
            <h3 className="panel-card__title">Workspace fleet</h3>
            <p className="panel-card__body">
              This table follows the Stitch layout reference: filter controls on top, dense operational rows, and
              destructive actions pushed to explicit modals.
            </p>
          </div>

          <div className="toolbar__filters">
            <select
              aria-label="Filter agents by status"
              className="dashboard-select"
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              value={statusFilter}
            >
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="revoked">Revoked only</option>
            </select>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "agent",
              header: "Agent",
              render: (agent) => (
                <div>
                  <div className="record-title">{agent.agent_id}</div>
                  <div className="record-meta">{agent.display_name ?? "No display name"}</div>
                </div>
              )
            },
            {
              key: "status",
              header: "Status",
              render: (agent) => <StatusBadge tone={toneForStatus(agent.status)}>{agent.status}</StatusBadge>
            },
            {
              key: "created",
              header: "Created",
              render: (agent) => (
                <div>
                  <div className="record-title">{formatDate(agent.created_at)}</div>
                  <div className="record-meta">{agent.revoked_at ? `Revoked ${formatDate(agent.revoked_at)}` : "Ready"}</div>
                </div>
              )
            },
            {
              key: "actions",
              header: "Actions",
              render: (agent) => (
                <div className="inline-actions">
                  <button
                    className="ghost-button"
                    disabled={agent.status !== "active"}
                    onClick={() => setConfirmAction({ type: "rotate", agent })}
                    type="button"
                  >
                    <KeyRound size={16} />
                    Rotate
                  </button>
                  <button
                    className="ghost-button"
                    disabled={agent.status !== "active"}
                    onClick={() => setConfirmAction({ type: "revoke", agent })}
                    type="button"
                  >
                    <ShieldBan size={16} />
                    Revoke
                  </button>
                </div>
              )
            }
          ]}
          emptyState={
            <EmptyState
              action={
                <button className="primary-button" onClick={() => setShowEnroll(true)} type="button">
                  <Plus size={16} />
                  Enroll first agent
                </button>
              }
              body="The Stitch management table is ready, but this workspace has no enrolled agents yet."
              title="No agents enrolled"
            />
          }
          footer={
            <>
              <span className="helper-copy">{loading ? "Loading agents..." : `${agents.length} rows loaded`}</span>
              <button className="ghost-button" disabled={!nextCursor || loadingMore} onClick={() => void loadAgents()} type="button">
                {loadingMore ? "Loading..." : nextCursor ? "Load more" : "No more rows"}
              </button>
            </>
          }
          loading={loading}
          rowKey={(agent) => agent.id}
          rows={agents}
        />
      </div>

      {showEnroll ? (
        <div className="modal-shell" role="dialog" aria-modal="true" aria-label="Enroll agent">
          <button aria-label="Close dialog" className="modal-shell__backdrop" onClick={() => setShowEnroll(false)} type="button" />
          <div className="modal-card">
            <div className="modal-card__header">
              <div className="brand-mark">
                <Bot size={18} />
              </div>
              <div>
                <div className="section-label">Enroll Agent Modal Screen</div>
                <h2 className="modal-card__title">Enroll a new agent</h2>
              </div>
            </div>

            <p className="modal-card__body">
              Issue a one-time bootstrap API key for a new workload identity. Agent IDs are workspace-scoped.
            </p>

            <form onSubmit={(event) => void handleEnroll(event)}>
              <div className="form-grid">
                <div className="field-stack">
                  <label htmlFor="agent-id">Agent ID</label>
                  <input
                    className="dashboard-input"
                    id="agent-id"
                    onChange={(event) => setAgentId(event.target.value)}
                    placeholder="agent:deploy-bot"
                    required
                    value={agentId}
                  />
                  <small>Allowed characters: letters, numbers, `.`, `_`, `:`, `@`, `-`.</small>
                </div>

                <div className="field-stack">
                  <label htmlFor="agent-display-name">Agent display name</label>
                  <input
                    className="dashboard-input"
                    id="agent-display-name"
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Production deploy bot"
                    value={displayName}
                  />
                  <small>Optional label shown in the operations table.</small>
                </div>
              </div>

              <div className="modal-card__actions">
                <button className="ghost-button" onClick={() => setShowEnroll(false)} type="button">
                  Cancel
                </button>
                <button className="primary-button" disabled={formPending} type="submit">
                  {formPending ? "Enrolling..." : "Create bootstrap key"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        body={
          confirmAction?.type === "rotate"
            ? `Rotate the API key for ${confirmAction.agent.agent_id}. The previous key will stop working immediately.`
            : `Revoke ${confirmAction?.agent.agent_id}. This agent will no longer be able to mint hosted access tokens.`
        }
        confirmLabel={confirmAction?.type === "rotate" ? "Rotate key" : "Revoke agent"}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => void handleConfirmAction()}
        open={Boolean(confirmAction)}
        pending={actionPending}
        title={confirmAction?.type === "rotate" ? "Rotate bootstrap API key" : "Revoke enrolled agent"}
      />

      <ApiKeyReveal
        apiKey={revealedKey?.apiKey ?? ""}
        description={revealedKey?.description ?? ""}
        onClose={() => setRevealedKey(null)}
        open={Boolean(revealedKey)}
        title={revealedKey?.title ?? "Bootstrap key"}
      />
    </section>
  );
}
