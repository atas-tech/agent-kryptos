import { Activity, BarChart3, Clock3, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getAnalyticsActiveAgents,
  getAnalyticsExchangeMetrics,
  getAnalyticsRequestVolume,
  type AnalyticsActiveAgentsResponse,
  type AnalyticsExchangePoint,
  type AnalyticsRequestPoint
} from "../api/dashboard.js";
import { EmptyState } from "../components/EmptyState.js";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric"
});

function formatDateLabel(value: string): string {
  return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function RequestVolumeChart({ points }: { points: AnalyticsRequestPoint[] }) {
  const maxValue = Math.max(...points.map((point) => point.count), 1);

  return (
    <div className="analytics-chart">
      <div className="analytics-chart__bars" aria-label="Request volume chart" role="img">
        {points.map((point) => (
          <div key={point.date} className="analytics-bar-group" title={`${formatDateLabel(point.date)}: ${point.count} requests`}>
            <div
              aria-hidden="true"
              className="analytics-bar analytics-bar--requests"
              style={{ height: `${Math.max((point.count / maxValue) * 100, point.count > 0 ? 10 : 3)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="analytics-chart__axis">
        <span>{formatDateLabel(points[0]?.date ?? new Date().toISOString().slice(0, 10))}</span>
        <span>{formatDateLabel(points.at(Math.floor(points.length / 2))?.date ?? new Date().toISOString().slice(0, 10))}</span>
        <span>{formatDateLabel(points.at(-1)?.date ?? new Date().toISOString().slice(0, 10))}</span>
      </div>
    </div>
  );
}

function ExchangeOutcomeChart({ points }: { points: AnalyticsExchangePoint[] }) {
  const maxValue = Math.max(
    ...points.map((point) => point.successful + point.failed_expired + point.denied),
    1
  );

  return (
    <div className="analytics-chart">
      <div className="analytics-chart__bars" aria-label="Exchange outcomes chart" role="img">
        {points.map((point) => {
          const total = point.successful + point.failed_expired + point.denied;
          return (
            <div key={point.date} className="analytics-bar-group" title={`${formatDateLabel(point.date)}: ${total} exchanges`}>
              <div className="analytics-stack">
                {point.successful > 0 ? (
                  <div
                    aria-hidden="true"
                    className="analytics-stack__segment analytics-stack__segment--success"
                    style={{ height: `${(point.successful / maxValue) * 100}%` }}
                  />
                ) : null}
                {point.failed_expired > 0 ? (
                  <div
                    aria-hidden="true"
                    className="analytics-stack__segment analytics-stack__segment--warning"
                    style={{ height: `${(point.failed_expired / maxValue) * 100}%` }}
                  />
                ) : null}
                {point.denied > 0 ? (
                  <div
                    aria-hidden="true"
                    className="analytics-stack__segment analytics-stack__segment--danger"
                    style={{ height: `${(point.denied / maxValue) * 100}%` }}
                  />
                ) : null}
                {total === 0 ? <div aria-hidden="true" className="analytics-stack__segment analytics-stack__segment--empty" /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="analytics-chart__axis">
        <span>{formatDateLabel(points[0]?.date ?? new Date().toISOString().slice(0, 10))}</span>
        <span>{formatDateLabel(points.at(Math.floor(points.length / 2))?.date ?? new Date().toISOString().slice(0, 10))}</span>
        <span>{formatDateLabel(points.at(-1)?.date ?? new Date().toISOString().slice(0, 10))}</span>
      </div>
    </div>
  );
}

export function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [hours, setHours] = useState(24);
  const [requestSeries, setRequestSeries] = useState<AnalyticsRequestPoint[]>([]);
  const [exchangeSeries, setExchangeSeries] = useState<AnalyticsExchangePoint[]>([]);
  const [activeAgents, setActiveAgents] = useState<AnalyticsActiveAgentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadAnalytics(nextDays = days, nextHours = hours): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const [requests, exchanges, agents] = await Promise.all([
        getAnalyticsRequestVolume(nextDays),
        getAnalyticsExchangeMetrics(nextDays),
        getAnalyticsActiveAgents(nextHours)
      ]);

      setRequestSeries(requests.series);
      setExchangeSeries(exchanges.series);
      setActiveAgents(agents);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load analytics");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAnalytics(days, hours);
  }, [days, hours]);

  const requestCount = useMemo(() => sum(requestSeries.map((point) => point.count)), [requestSeries]);
  const successfulExchanges = useMemo(() => sum(exchangeSeries.map((point) => point.successful)), [exchangeSeries]);
  const failedExchanges = useMemo(() => sum(exchangeSeries.map((point) => point.failed_expired)), [exchangeSeries]);
  const deniedExchanges = useMemo(() => sum(exchangeSeries.map((point) => point.denied)), [exchangeSeries]);

  return (
    <section className="page-stack">
      <div className="hero-card hero-card--dashboard">
        <div className="toolbar">
          <div>
            <div className="section-label">Milestone 2</div>
            <h2 className="hero-card__title">Workspace analytics</h2>
            <p className="hero-card__body">
              Review request volume, exchange outcomes, and recent active agents without exposing secret names, token
              material, or per-agent identities.
            </p>
          </div>

          <div className="toolbar__actions">
            <label>
              <span className="sr-only">Analytics window</span>
              <select
                aria-label="Analytics window"
                className="dashboard-select"
                data-testid="analytics-days-select"
                onChange={(event) => setDays(Number.parseInt(event.target.value, 10))}
                value={days}
              >
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="60">Last 60 days</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Active agent window</span>
              <select
                aria-label="Active agent window"
                className="dashboard-select"
                data-testid="analytics-hours-select"
                onChange={(event) => setHours(Number.parseInt(event.target.value, 10))}
                value={hours}
              >
                <option value="24">24 hours</option>
                <option value="72">72 hours</option>
                <option value="168">7 days</option>
              </select>
            </label>
            <button className="ghost-button" disabled={loading} onClick={() => void loadAnalytics()} type="button">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>Request volume</span>
            <strong>{requestCount}</strong>
            <div className="analytics-metric-copy">
              <BarChart3 size={16} />
              <small>{days}-day audit-backed request count</small>
            </div>
          </article>
          <article className="metric-panel">
            <span>Successful exchanges</span>
            <strong>{successfulExchanges}</strong>
            <div className="analytics-metric-copy">
              <ShieldCheck size={16} />
              <small>Terminal `exchange_retrieved` outcomes</small>
            </div>
          </article>
          <article className="metric-panel">
            <span>Failed or expired</span>
            <strong>{failedExchanges}</strong>
            <div className="analytics-metric-copy">
              <ShieldAlert size={16} />
              <small>Revoked or failed end states</small>
            </div>
          </article>
          <article className="metric-panel">
            <span>Active agents</span>
            <strong>{activeAgents?.active_agents ?? 0}</strong>
            <div className="analytics-metric-copy">
              <Activity size={16} />
              <small>Distinct token-mint actors in {activeAgents?.hours ?? hours}h</small>
            </div>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {loading && requestSeries.length === 0 && exchangeSeries.length === 0 ? (
        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">Analytics</div>
              <h3 className="panel-card__title">Loading workspace telemetry</h3>
              <p className="panel-card__body">Reading audit-backed aggregates from the hosted control plane.</p>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && !error && requestCount === 0 && successfulExchanges === 0 && failedExchanges === 0 && deniedExchanges === 0 ? (
        <EmptyState
          title="No analytics traffic yet"
          body="Once this workspace starts creating requests and completing exchanges, the charts will fill with daily activity."
        />
      ) : null}

      {(requestSeries.length > 0 || exchangeSeries.length > 0 || activeAgents) ? (
        <div className="section-grid">
          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Request volume</div>
                <h3 className="panel-card__title">Daily secret requests</h3>
                <p className="panel-card__body">Each bar shows the number of hosted secret requests created on that day.</p>
              </div>
            </div>

            <RequestVolumeChart points={requestSeries} />
          </div>

          <div className="panel-card">
            <div className="panel-card__header">
              <div>
                <div className="section-label">Exchange outcomes</div>
                <h3 className="panel-card__title">Successful, failed, and denied flows</h3>
                <p className="panel-card__body">Stacked columns show terminal exchange outcomes without exposing payload metadata.</p>
              </div>
            </div>

            <ExchangeOutcomeChart points={exchangeSeries} />

            <div className="analytics-legend">
              <div className="analytics-legend__item">
                <span className="analytics-legend__swatch analytics-legend__swatch--success" />
                <span>Successful</span>
              </div>
              <div className="analytics-legend__item">
                <span className="analytics-legend__swatch analytics-legend__swatch--warning" />
                <span>Failed / expired</span>
              </div>
              <div className="analytics-legend__item">
                <span className="analytics-legend__swatch analytics-legend__swatch--danger" />
                <span>Denied</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">Activity posture</div>
            <h3 className="panel-card__title">What this window says</h3>
            <p className="panel-card__body">Use this readout to distinguish normal workload from repeated failures or policy friction.</p>
          </div>
        </div>

        <div className="analytics-insights">
          <article className="analytics-insight">
            <div className="analytics-insight__header">
              <Clock3 size={16} />
              <strong>{days}-day request pace</strong>
            </div>
            <p>
              {requestCount === 0
                ? "No request creation has been recorded in this window."
                : `${requestCount} requests were created across the selected period.`}
            </p>
          </article>
          <article className="analytics-insight">
            <div className="analytics-insight__header">
              <ShieldCheck size={16} />
              <strong>Exchange completion</strong>
            </div>
            <p>
              {successfulExchanges >= failedExchanges + deniedExchanges
                ? "Successful exchange retrievals currently outweigh failed and denied paths."
                : "Failed or denied exchanges are outpacing successful retrievals in this window."}
            </p>
          </article>
          <article className="analytics-insight">
            <div className="analytics-insight__header">
              <Activity size={16} />
              <strong>Recent agent activity</strong>
            </div>
            <p>
              {activeAgents?.active_agents
                ? `${activeAgents.active_agents} distinct agents minted tokens in the last ${activeAgents.hours} hours.`
                : "No agent token mint activity has been recorded in the selected activity window."}
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
