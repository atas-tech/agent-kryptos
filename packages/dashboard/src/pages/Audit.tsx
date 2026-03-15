import { ArrowLeft, ArrowRight, RefreshCw, ScanSearch } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiRequest } from "../api/client.js";
import { DataTable } from "../components/DataTable.js";
import { EmptyState } from "../components/EmptyState.js";
import { ResourceLabel } from "../components/ResourceLabel.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface AuditRecord {
  id: string;
  workspace_id: string | null;
  event_type: string;
  actor_id: string | null;
  actor_type: "user" | "agent" | "system" | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

interface AuditListResponse {
  records: AuditRecord[];
  next_cursor: string | null;
}

interface ExchangeAuditResponse {
  exchange_id: string;
  records: AuditRecord[];
}

interface AuditFilters {
  eventType: string;
  actorType: "" | "user" | "agent" | "system";
  resourceId: string;
  from: string;
  to: string;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});

const EXCHANGE_ID_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_FILTERS: AuditFilters = {
  eventType: "",
  actorType: "",
  resourceId: "",
  from: "",
  to: ""
};

const AUDIT_EVENT_OPTIONS = [
  "request_created",
  "secret_submitted",
  "secret_retrieved",
  "request_expired",
  "request_revoked",
  "exchange_requested",
  "exchange_reserved",
  "exchange_submitted",
  "exchange_retrieved",
  "exchange_revoked",
  "exchange_approval_requested",
  "exchange_approved",
  "exchange_rejected",
  "exchange_pending_approval",
  "exchange_denied",
  "agent_enrolled",
  "agent_api_key_rotated",
  "agent_revoked",
  "member_created",
  "member_updated"
];

function formatTimestamp(value: string): string {
  return dateFormatter.format(new Date(value));
}

function eventTone(eventType: string): "success" | "warning" | "danger" | "neutral" {
  if (eventType.endsWith("retrieved") || eventType.endsWith("approved") || eventType.endsWith("submitted")) {
    return "success";
  }

  if (eventType.endsWith("rejected") || eventType.endsWith("denied") || eventType.endsWith("revoked")) {
    return "danger";
  }

  if (eventType.endsWith("expired") || eventType.endsWith("pending_approval")) {
    return "warning";
  }

  return "neutral";
}

function dateRangeStart(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return new Date(`${value}T00:00:00`).toISOString();
}

function dateRangeEnd(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return new Date(`${value}T23:59:59.999`).toISOString();
}

function getExchangeId(record: AuditRecord): string | null {
  if (record.resource_id && EXCHANGE_ID_PATTERN.test(record.resource_id)) {
    return record.resource_id;
  }

  const metadataExchangeId = record.metadata?.exchange_id;
  return typeof metadataExchangeId === "string" && EXCHANGE_ID_PATTERN.test(metadataExchangeId)
    ? metadataExchangeId
    : null;
}

function metadataPreview(metadata: Record<string, unknown> | null): string {
  return JSON.stringify(metadata ?? { masked: true }, null, 2);
}

export function AuditPage() {
  const navigate = useNavigate();
  const { exchangeId } = useParams();
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [timelineRecords, setTimelineRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (exchangeId) {
      void loadExchangeTimeline(exchangeId);
      return;
    }

    void loadAuditRecords(true, appliedFilters);
  }, [appliedFilters, exchangeId]);

  async function loadAuditRecords(reset: boolean, activeFilters = appliedFilters): Promise<void> {
    if (reset) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams();
      params.set("limit", "12");
      if (!reset && nextCursor) {
        params.set("cursor", nextCursor);
      }
      if (activeFilters.eventType) {
        params.set("event_type", activeFilters.eventType);
      }
      if (activeFilters.actorType) {
        params.set("actor_type", activeFilters.actorType);
      }
      if (activeFilters.resourceId.trim()) {
        params.set("resource_id", activeFilters.resourceId.trim());
      }

      const from = dateRangeStart(activeFilters.from);
      const to = dateRangeEnd(activeFilters.to);
      if (from) {
        params.set("from", from);
      }
      if (to) {
        params.set("to", to);
      }

      const payload = await apiRequest<AuditListResponse>(`/api/v2/audit?${params.toString()}`);
      setRecords((current) => {
        if (reset) {
          return payload.records;
        }

        const knownIds = new Set(current.map((record) => record.id));
        return current.concat(payload.records.filter((record) => !knownIds.has(record.id)));
      });
      setNextCursor(payload.next_cursor);
      if (reset) {
        setExpandedRowId(null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load audit records");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  async function loadExchangeTimeline(id: string): Promise<void> {
    setTimelineLoading(true);
    setError(null);

    try {
      const payload = await apiRequest<ExchangeAuditResponse>(`/api/v2/audit/exchange/${id}`);
      setTimelineRecords(payload.records);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load exchange lifecycle");
      setTimelineRecords([]);
    } finally {
      setTimelineLoading(false);
    }
  }

  function handleApplyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAppliedFilters(filters);
  }

  function handleResetFilters(): void {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
  }

  if (exchangeId) {
    const approvalEvents = timelineRecords.filter((record) => record.event_type.includes("approval")).length;
    const latestEvent = timelineRecords.at(-1)?.event_type ?? "pending";

    return (
      <section className="page-stack">
        <div className="hero-card hero-card--dashboard">
          <div className="toolbar">
            <div>
              <div className="section-label">Milestone 4</div>
              <h2 className="hero-card__title">Exchange lifecycle timeline</h2>
              <p className="hero-card__body">
                This drill-down follows the Stitch forensic timeline pattern: every exchange state is rendered in
                sequence, and any approval events are interleaved without exposing ciphertext or tokens.
              </p>
            </div>

            <div className="toolbar__actions">
              <button className="ghost-button" onClick={() => navigate("/audit")} type="button">
                <ArrowLeft size={16} />
                Back to audit
              </button>
              <button className="ghost-button" onClick={() => void loadExchangeTimeline(exchangeId)} type="button">
                <RefreshCw size={16} />
                Refresh
              </button>
            </div>
          </div>

          <div className="stats-row">
            <article className="metric-panel">
              <span>Exchange</span>
              <ResourceLabel className="mt-1" truncateAt={8} value={exchangeId} />
            </article>
            <article className="metric-panel">
              <span>Timeline events</span>
              <strong>{timelineRecords.length}</strong>
            </article>
            <article className="metric-panel">
              <span>Approval events</span>
              <strong>{approvalEvents}</strong>
            </article>
            <article className="metric-panel">
              <span>Latest state</span>
              <strong>{latestEvent.replaceAll("_", " ")}</strong>
            </article>
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Exchange Timeline</div>
              <h3 className="panel-card__title">Interleaved audit history</h3>
              <p className="panel-card__body">
                Requested, reserved, submitted, retrieved, and approval decision events are rendered in chronological
                order from the workspace-scoped audit timeline.
              </p>
            </div>
          </div>

          {timelineLoading ? (
            <div className="empty-state">
              <div className="empty-state__eyebrow">Loading</div>
              <h3>Building lifecycle view</h3>
              <p>Fetching the exchange timeline and approval trail now.</p>
            </div>
          ) : timelineRecords.length === 0 ? (
            <EmptyState
              body="No exchange lifecycle events were found for this workspace-scoped exchange id."
              title="Timeline unavailable"
            />
          ) : (
            <div className="timeline-list">
              {timelineRecords.map((record) => (
                <article key={record.id} className="timeline-entry">
                  <div className={`timeline-entry__rail timeline-entry__rail--${eventTone(record.event_type)}`} />
                  <div className="timeline-entry__content">
                    <div className="timeline-entry__header">
                      <div>
                        <div className="record-title">{record.event_type.replaceAll("_", " ")}</div>
                        <div className="record-meta">{formatTimestamp(record.created_at)}</div>
                      </div>
                      <StatusBadge tone={eventTone(record.event_type)}>{record.actor_type ?? "system"}</StatusBadge>
                    </div>

                    <div className="detail-list">
                      <div className="detail-list__item">
                        <span className="meta-label">Actor</span>
                        <ResourceLabel value={record.actor_id ?? "system"} />
                      </div>
                      <div className="detail-list__item">
                        <span className="meta-label">Resource</span>
                        <ResourceLabel value={record.resource_id ?? "n/a"} />
                      </div>
                    </div>

                    <pre className="audit-metadata">{metadataPreview(record.metadata)}</pre>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  const exchangeRecords = records.filter((record) => getExchangeId(record)).length;
  const approvalRecords = records.filter((record) => record.event_type.includes("approval")).length;

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">Milestone 4</div>
            <h2 className="hero-card__title">Audit log viewer</h2>
            <p className="hero-card__body">
              Monitor user, agent, and system activity from the Stitch-aligned audit table. Filters, masked metadata,
              pagination, and exchange drill-downs stay available to every workspace role.
            </p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => void loadAuditRecords(true)} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Visible rows</span>
            <strong>{records.length}</strong>
          </article>
          <article className="metric-panel">
            <span>Exchange events</span>
            <strong>{exchangeRecords}</strong>
          </article>
          <article className="metric-panel">
            <span>Approval events</span>
            <strong>{approvalRecords}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">Audit Filters</div>
            <h3 className="panel-card__title">Search and scope</h3>
            <p className="panel-card__body">
              Filter by event type, actor class, resource id, or date range before paginating deeper into the audit
              stream.
            </p>
          </div>
        </div>

        <form className="audit-filters" onSubmit={handleApplyFilters}>
          <label className="field-stack">
            <span>Event type</span>
            <select
              aria-label="Filter audit by event type"
              className="dashboard-select"
              onChange={(event) => setFilters((current) => ({ ...current, eventType: event.target.value }))}
              value={filters.eventType}
            >
              <option value="">All events</option>
              {AUDIT_EVENT_OPTIONS.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventType}
                </option>
              ))}
            </select>
          </label>

          <label className="field-stack">
            <span>Actor type</span>
            <select
              aria-label="Filter audit by actor type"
              className="dashboard-select"
              onChange={(event) => setFilters((current) => ({ ...current, actorType: event.target.value as AuditFilters["actorType"] }))}
              value={filters.actorType}
            >
              <option value="">All actors</option>
              <option value="user">User</option>
              <option value="agent">Agent</option>
              <option value="system">System</option>
            </select>
          </label>

          <label className="field-stack">
            <span>Resource id</span>
            <input
              aria-label="Filter audit by resource id"
              className="dashboard-input"
              onChange={(event) => setFilters((current) => ({ ...current, resourceId: event.target.value }))}
              placeholder="exchange id, member id, or approval ref"
              type="text"
              value={filters.resourceId}
            />
          </label>

          <label className="field-stack">
            <span>From date</span>
            <input
              aria-label="Filter audit from date"
              className="dashboard-input"
              onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
              type="date"
              value={filters.from}
            />
          </label>

          <label className="field-stack">
            <span>To date</span>
            <input
              aria-label="Filter audit to date"
              className="dashboard-input"
              onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
              type="date"
              value={filters.to}
            />
          </label>

          <div className="audit-filters__actions">
            <button className="primary-button" type="submit">
              <ScanSearch size={16} />
              Apply filters
            </button>
            <button className="ghost-button" onClick={handleResetFilters} type="button">
              Reset
            </button>
          </div>
        </form>
      </div>

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">Audit Stream</div>
            <h3 className="panel-card__title">Workspace events</h3>
            <p className="panel-card__body">
              Click any row to inspect the sanitized metadata payload. Exchange rows expose a direct forensic drill-down
              into the full lifecycle timeline.
            </p>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "created",
              header: "Recorded",
              render: (record) => (
                <div>
                  <div className="record-title">{formatTimestamp(record.created_at)}</div>
                  <div className="record-meta">{record.ip_address ?? "No forwarded IP"}</div>
                </div>
              )
            },
            {
              key: "event",
              header: "Event",
              render: (record) => <StatusBadge tone={eventTone(record.event_type)}>{record.event_type}</StatusBadge>
            },
            {
              key: "actor",
              header: "Actor",
              render: (record) => (
                <div>
                  <div className="record-title">{record.actor_id ?? "system"}</div>
                  <div className="record-meta">{record.actor_type ?? "system"}</div>
                </div>
              )
            },
            {
              key: "resource",
              header: "Resource",
              render: (record) => (
                <div>
                  <ResourceLabel value={record.resource_id ?? "n/a"} />
                  <div className="record-meta">
                    {getExchangeId(record) ? "Exchange drill-down available" : "Metadata details only"}
                  </div>
                </div>
              )
            },
            {
              key: "action",
              header: "Action",
              render: (record) => {
                const recordExchangeId = getExchangeId(record);

                return recordExchangeId ? (
                  <button
                    className="ghost-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      navigate(`/audit/exchange/${recordExchangeId}`);
                    }}
                    type="button"
                  >
                    Open exchange
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <span className="record-meta">Inspect metadata</span>
                );
              }
            }
          ]}
          emptyState={
            <EmptyState
              body="No audit events matched the current filters. Adjust the search scope or refresh after more workspace activity occurs."
              title="No audit rows match"
            />
          }
          expandedRowKey={expandedRowId}
          footer={
            <div className="toolbar">
              <div className="helper-copy">Masked JSON expansion is read-only for every workspace role.</div>
              <button
                className="ghost-button"
                disabled={!nextCursor || loadingMore}
                onClick={() => void loadAuditRecords(false)}
                type="button"
              >
                {loadingMore ? "Loading..." : nextCursor ? "Load more" : "No more rows"}
              </button>
            </div>
          }
          loading={loading}
          onRowClick={(record) => setExpandedRowId((current) => (current === record.id ? null : record.id))}
          renderExpandedRow={(record) => {
            const recordExchangeId = getExchangeId(record);

            return (
              <div className="audit-expanded">
                <div className="audit-expanded__header">
                  <div>
                    <div className="record-title">Sanitized metadata</div>
                    <div className="record-meta">Sensitive values remain masked at the API boundary.</div>
                  </div>
                  {recordExchangeId ? (
                    <button className="ghost-button" onClick={() => navigate(`/audit/exchange/${recordExchangeId}`)} type="button">
                      Open exchange
                      <ArrowRight size={16} />
                    </button>
                  ) : null}
                </div>
                <pre className="audit-metadata">{metadataPreview(record.metadata)}</pre>
              </div>
            );
          }}
          rowKey={(record) => record.id}
          rows={records}
        />
      </div>
    </section>
  );
}
