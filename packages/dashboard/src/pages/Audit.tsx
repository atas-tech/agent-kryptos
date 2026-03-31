import { ArrowLeft, ArrowRight, RefreshCw, ScanSearch } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { apiRequest, ApiError } from "../api/client.js";
import { DataTable } from "../components/DataTable.js";
import { EmptyState } from "../components/EmptyState.js";
import { ResourceLabel } from "../components/ResourceLabel.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface AuditRecord {
  id: string;
  workspace_id: string | null;
  event_type: string;
  actor_id: string | null;
  actor_type: "user" | "agent" | "system" | "guest_agent" | "guest_human" | null;
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
  actorType: "" | "user" | "agent" | "system" | "guest_agent" | "guest_human";
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
  const { t } = useTranslation(["audit", "common"]);
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
      setError(requestError instanceof Error ? requestError.message : t("audit:errors.loadFailed"));
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
      if (requestError instanceof ApiError && requestError.status === 404) {
        setTimelineRecords([]);
      } else {
        setError(requestError instanceof Error ? requestError.message : t("audit:errors.timelineFailed"));
        setTimelineRecords([]);
      }
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
    const latestEvent = timelineRecords.at(-1)?.event_type ?? t("common:pending");

    return (
      <section className="page-stack" data-testid="audit-page-exchange-view">
        <div className="hero-card hero-card--dashboard">
          <div className="toolbar">
            <div>
              <div className="section-label">{t("audit:timeline.sectionLabel")}</div>
              <h2 className="hero-card__title">{t("audit:timeline.title")}</h2>
              <p className="hero-card__body">{t("audit:timeline.body")}</p>
            </div>

            <div className="toolbar__actions">
              <button className="ghost-button" onClick={() => navigate("/audit")} type="button">
                <ArrowLeft size={16} />
                {t("audit:timeline.backToAudit")}
              </button>
              <button className="ghost-button" onClick={() => void loadExchangeTimeline(exchangeId)} type="button">
                <RefreshCw size={16} />
                {t("common:refresh")}
              </button>
            </div>
          </div>

          <div className="stats-row">
            <article className="metric-panel">
              <span>{t("audit:stats.exchange")}</span>
              <ResourceLabel className="mt-1" truncateAt={8} value={exchangeId} />
            </article>
            <article className="metric-panel">
              <span>{t("audit:stats.timelineEvents")}</span>
              <strong>{timelineRecords.length}</strong>
            </article>
            <article className="metric-panel">
              <span>{t("audit:stats.approvalEvents")}</span>
              <strong>{approvalEvents}</strong>
            </article>
            <article className="metric-panel">
              <span>{t("audit:stats.latestState")}</span>
              <strong>{latestEvent.replaceAll("_", " ")}</strong>
            </article>
          </div>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("audit:timeline.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("audit:timeline.tableTitle")}</h3>
              <p className="panel-card__body">{t("audit:timeline.tableBody")}</p>
            </div>
          </div>

          {timelineLoading ? (
            <div className="empty-state">
              <div className="empty-state__eyebrow">{t("common:loading")}</div>
              <h3>{t("audit:timeline.loadingTitle")}</h3>
              <p>{t("audit:timeline.loadingBody")}</p>
            </div>
          ) : timelineRecords.length === 0 ? (
            <EmptyState
              body={t("audit:timeline.emptyBody")}
              dataTestId="audit-empty-state"
              title={t("audit:timeline.emptyTitle")}
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
                      <StatusBadge tone={eventTone(record.event_type)}>{record.actor_type ?? t("common:system")}</StatusBadge>
                    </div>

                    <div className="detail-list">
                      <div className="detail-list__item">
                        <span className="meta-label">{t("audit:timeline.actorLabel")}</span>
                        <ResourceLabel value={record.actor_id ?? t("common:system")} />
                      </div>
                      <div className="detail-list__item">
                        <span className="meta-label">{t("audit:timeline.resourceLabel")}</span>
                        <ResourceLabel value={record.resource_id ?? t("common:notAvailable")} />
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
    <section className="page-stack" data-testid="audit-page-list-view">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">{t("audit:hero.sectionLabel")}</div>
            <h2 className="hero-card__title">{t("audit:hero.title")}</h2>
            <p className="hero-card__body">{t("audit:hero.body")}</p>
          </div>

          <div className="toolbar__actions">
            <button className="ghost-button" onClick={() => void loadAuditRecords(true)} type="button">
              <RefreshCw size={16} />
              {t("common:refresh")}
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("audit:stats.visibleRows")}</span>
            <strong>{records.length}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("audit:stats.exchangeEvents")}</span>
            <strong>{exchangeRecords}</strong>
          </article>
          <article className="metric-panel">
            <span>{t("audit:stats.approvalEvents")}</span>
            <strong>{approvalRecords}</strong>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">{t("audit:filters.sectionLabel")}</div>
            <h3 className="panel-card__title">{t("audit:filters.title")}</h3>
            <p className="panel-card__body">{t("audit:filters.body")}</p>
          </div>
        </div>

        <form className="audit-filters" onSubmit={handleApplyFilters}>
          <label className="field-stack">
            <span>{t("audit:filters.eventType")}</span>
            <select
              aria-label={t("audit:filters.eventType")}
              className="dashboard-select"
              onChange={(event) => setFilters((current) => ({ ...current, eventType: event.target.value }))}
              value={filters.eventType}
            >
              <option value="">{t("audit:filters.allEvents")}</option>
              {AUDIT_EVENT_OPTIONS.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventType}
                </option>
              ))}
            </select>
          </label>

          <label className="field-stack">
            <span>{t("audit:filters.actorType")}</span>
            <select
              aria-label={t("audit:filters.actorType")}
              className="dashboard-select"
              onChange={(event) => setFilters((current) => ({ ...current, actorType: event.target.value as AuditFilters["actorType"] }))}
              value={filters.actorType}
            >
              <option value="">{t("audit:filters.allActors")}</option>
              <option value="user">{t("audit:filters.user")}</option>
              <option value="agent">{t("audit:filters.agent")}</option>
              <option value="system">{t("audit:filters.system")}</option>
            </select>
          </label>

          <label className="field-stack">
            <span>{t("audit:filters.resourceId")}</span>
            <input
              aria-label={t("audit:filters.resourceId")}
              className="dashboard-input"
              onChange={(event) => setFilters((current) => ({ ...current, resourceId: event.target.value }))}
              placeholder={t("audit:filters.resourceIdPlaceholder")}
              type="text"
              value={filters.resourceId}
            />
          </label>

          <label className="field-stack">
            <span>{t("audit:filters.fromDate")}</span>
            <input
              aria-label={t("audit:filters.fromDate")}
              className="dashboard-input"
              onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
              type="date"
              value={filters.from}
            />
          </label>

          <label className="field-stack">
            <span>{t("audit:filters.toDate")}</span>
            <input
              aria-label={t("audit:filters.toDate")}
              className="dashboard-input"
              onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
              type="date"
              value={filters.to}
            />
          </label>

          <div className="audit-filters__actions">
            <button className="primary-button" type="submit">
              <ScanSearch size={16} />
              {t("audit:filters.applyButton")}
            </button>
            <button className="ghost-button" onClick={handleResetFilters} type="button">
              {t("audit:filters.resetButton")}
            </button>
          </div>
        </form>
      </div>

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">{t("audit:table.sectionLabel")}</div>
            <h3 className="panel-card__title">{t("audit:table.title")}</h3>
            <p className="panel-card__body">{t("audit:table.body")}</p>
          </div>
        </div>

        <DataTable
          columns={[
            {
              key: "created",
              header: t("audit:table.columnRecorded"),
              render: (record) => (
                <div>
                  <div className="record-title">{formatTimestamp(record.created_at)}</div>
                  <div className="record-meta">{record.ip_address ?? t("audit:table.noForwardedIp")}</div>
                </div>
              )
            },
            {
              key: "event",
              header: t("audit:table.columnEvent"),
              render: (record) => <StatusBadge tone={eventTone(record.event_type)}>{record.event_type}</StatusBadge>
            },
            {
              key: "actor",
              header: t("audit:table.columnActor"),
              render: (record) => (
                <div>
                  <div className="record-title">{record.actor_id ?? t("common:system")}</div>
                  <div className="record-meta">{record.actor_type ?? t("common:system")}</div>
                </div>
              )
            },
            {
              key: "resource",
              header: t("audit:table.columnResource"),
              render: (record) => (
                <div>
                  <ResourceLabel value={record.resource_id ?? t("common:notAvailable")} />
                  <div className="record-meta">
                    {getExchangeId(record) ? t("audit:table.exchangeDrillDown") : t("audit:table.metadataOnly")}
                  </div>
                </div>
              )
            },
            {
              key: "action",
              header: t("audit:table.columnAction"),
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
                    {t("audit:table.openExchange")}
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <span className="record-meta">{t("audit:table.inspectMetadata")}</span>
                );
              }
            }
          ]}
          emptyState={
            <EmptyState
              body={t("audit:table.emptyBody")}
              title={t("audit:table.emptyTitle")}
            />
          }
          expandedRowKey={expandedRowId}
          footer={
            <div className="toolbar">
              <div className="helper-copy">{t("audit:table.footerHint")}</div>
              <button
                className="ghost-button"
                disabled={!nextCursor || loadingMore}
                onClick={() => void loadAuditRecords(false)}
                type="button"
              >
                {loadingMore ? t("common:loading") : nextCursor ? t("common:loadMore") : t("common:noMoreRows")}
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
                    <div className="record-title">{t("audit:table.sanitizedMetadata")}</div>
                    <div className="record-meta">{t("audit:table.sanitizedMetadataHint")}</div>
                  </div>
                  {recordExchangeId ? (
                    <button className="ghost-button" onClick={() => navigate(`/audit/exchange/${recordExchangeId}`)} type="button">
                      {t("audit:table.openExchange")}
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
