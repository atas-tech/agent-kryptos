import { Activity, BarChart3, Clock3, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

function RequestVolumeChart({
  points,
  ariaLabel,
  formatPointTitle
}: {
  points: AnalyticsRequestPoint[];
  ariaLabel: string;
  formatPointTitle: (point: AnalyticsRequestPoint) => string;
}) {
  const maxValue = Math.max(...points.map((point) => point.count), 1);

  return (
    <div className="analytics-chart">
      <div className="analytics-chart__bars" aria-label={ariaLabel} role="img">
        {points.map((point) => (
          <div key={point.date} className="analytics-bar-group" title={formatPointTitle(point)}>
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

function ExchangeOutcomeChart({
  points,
  ariaLabel,
  formatPointTitle
}: {
  points: AnalyticsExchangePoint[];
  ariaLabel: string;
  formatPointTitle: (point: AnalyticsExchangePoint) => string;
}) {
  const maxValue = Math.max(
    ...points.map((point) => point.successful + point.failed_expired + point.denied),
    1
  );

  return (
    <div className="analytics-chart">
      <div className="analytics-chart__bars" aria-label={ariaLabel} role="img">
        {points.map((point) => {
          const total = point.successful + point.failed_expired + point.denied;
          return (
            <div key={point.date} className="analytics-bar-group" title={formatPointTitle(point)}>
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
  const { t } = useTranslation(["analytics", "common"]);
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
      setError(requestError instanceof Error ? requestError.message : t("analytics:errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    console.log("[DEBUG] AnalyticsPage mounted, loading:", loading);
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
            <div className="section-label">{t("analytics:hero.sectionLabel")}</div>
            <h2 className="hero-card__title" data-testid="analytics-title">{t("analytics:hero.title")}</h2>
            <p className="hero-card__body">{t("analytics:hero.body")}</p>
          </div>

          <div className="toolbar__actions">
            <label>
              <span className="sr-only">{t("analytics:controls.analyticsWindow")}</span>
              <select
                aria-label={t("analytics:controls.analyticsWindow")}
                className="dashboard-select"
                data-testid="analytics-days-select"
                onChange={(event) => setDays(Number.parseInt(event.target.value, 10))}
                value={days}
              >
                <option value="7">{t("analytics:dateRanges.last7Days")}</option>
                <option value="30">{t("analytics:dateRanges.last30Days")}</option>
                <option value="60">{t("analytics:dateRanges.last60Days")}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{t("analytics:controls.activeAgentWindow")}</span>
              <select
                aria-label={t("analytics:controls.activeAgentWindow")}
                className="dashboard-select"
                data-testid="analytics-hours-select"
                onChange={(event) => setHours(Number.parseInt(event.target.value, 10))}
                value={hours}
              >
                <option value="24">{t("analytics:dateRanges.24Hours")}</option>
                <option value="72">{t("analytics:dateRanges.72Hours")}</option>
                <option value="168">{t("analytics:dateRanges.7Days")}</option>
              </select>
            </label>
            <button className="ghost-button" disabled={loading} onClick={() => void loadAnalytics()} type="button">
              <RefreshCw size={16} />
              {t("common:refresh")}
            </button>
          </div>
        </div>

        <div className="stats-row">
          <article className="metric-panel">
            <span>{t("analytics:stats.requestVolume")}</span>
            <strong data-testid="analytics-request-count-value">{requestCount}</strong>
            <div className="analytics-metric-copy">
              <BarChart3 size={16} />
              <small>{t("analytics:stats.requestVolumeHelper", { days })}</small>
            </div>
          </article>
          <article className="metric-panel">
            <span>{t("analytics:stats.successfulExchanges")}</span>
            <strong data-testid="analytics-successful-exchanges">{successfulExchanges}</strong>
            <div className="analytics-metric-copy">
              <ShieldCheck size={16} />
              <small>{t("analytics:stats.successfulExchangesHelper")}</small>
            </div>
          </article>
          <article className="metric-panel">
            <span>{t("analytics:stats.failedExpired")}</span>
            <strong data-testid="analytics-failed-exchanges">{failedExchanges}</strong>
            <div className="analytics-metric-copy">
              <ShieldAlert size={16} />
              <small>{t("analytics:stats.failedExpiredHelper")}</small>
            </div>
          </article>
          <article className="metric-panel">
            <span>{t("analytics:stats.activeAgents")}</span>
            <strong data-testid="analytics-active-agents">{activeAgents?.active_agents ?? 0}</strong>
            <div className="analytics-metric-copy">
              <Activity size={16} />
              <small>{t("analytics:stats.activeAgentsHelper", { hours: activeAgents?.hours ?? hours })}</small>
            </div>
          </article>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {loading && requestSeries.length === 0 && exchangeSeries.length === 0 ? (
        <div className="panel-card">
          <div className="panel-card__header">
            <div>
              <div className="section-label">{t("analytics:loading.sectionLabel")}</div>
              <h3 className="panel-card__title">{t("analytics:loading.title")}</h3>
              <p className="panel-card__body">{t("analytics:loading.body")}</p>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && !error && requestCount === 0 && successfulExchanges === 0 && failedExchanges === 0 && deniedExchanges === 0 ? (
        <EmptyState
          title={t("analytics:emptyState.title")}
          body={t("analytics:emptyState.body")}
        />
      ) : null}

      {(requestSeries.length > 0 || exchangeSeries.length > 0 || activeAgents) ? (
        <div className="section-grid">
          <div className="panel-card" data-testid="metric-request-volume">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("analytics:requestVolume.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("analytics:requestVolume.title")}</h3>
                <p className="panel-card__body">{t("analytics:requestVolume.body")}</p>
              </div>
            </div>

            <RequestVolumeChart
              ariaLabel={t("analytics:requestVolume.chartAria")}
              formatPointTitle={(point) => t("analytics:requestVolume.chartPoint", { date: formatDateLabel(point.date), count: point.count })}
              points={requestSeries}
            />
          </div>

          <div className="panel-card" data-testid="metric-delivery-rate">
            <div className="panel-card__header">
              <div>
                <div className="section-label">{t("analytics:exchangeOutcomes.sectionLabel")}</div>
                <h3 className="panel-card__title">{t("analytics:exchangeOutcomes.title")}</h3>
                <p className="panel-card__body">{t("analytics:exchangeOutcomes.body")}</p>
              </div>
            </div>

            <ExchangeOutcomeChart
              ariaLabel={t("analytics:exchangeOutcomes.chartAria")}
              formatPointTitle={(point) =>
                t("analytics:exchangeOutcomes.chartPoint", {
                  date: formatDateLabel(point.date),
                  count: point.successful + point.failed_expired + point.denied
                })}
              points={exchangeSeries}
            />

            <div className="analytics-legend">
              <div className="analytics-legend__item">
                <span className="analytics-legend__swatch analytics-legend__swatch--success" />
                <span>{t("analytics:exchangeOutcomes.legendSuccessful")}</span>
              </div>
              <div className="analytics-legend__item">
                <span className="analytics-legend__swatch analytics-legend__swatch--warning" />
                <span>{t("analytics:exchangeOutcomes.legendFailed")}</span>
              </div>
              <div className="analytics-legend__item">
                <span className="analytics-legend__swatch analytics-legend__swatch--danger" />
                <span>{t("analytics:exchangeOutcomes.legendDenied")}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel-card">
        <div className="panel-card__header">
          <div>
            <div className="section-label">{t("analytics:insights.sectionLabel")}</div>
            <h3 className="panel-card__title">{t("analytics:insights.title")}</h3>
            <p className="panel-card__body">{t("analytics:insights.body")}</p>
          </div>
        </div>

        <div className="analytics-insights">
          <article className="analytics-insight">
            <div className="analytics-insight__header">
              <Clock3 size={16} />
              <strong>{t("analytics:insights.requestPaceTitle", { days })}</strong>
            </div>
            <p>
              {requestCount === 0
                ? t("analytics:insights.requestPaceNoRequests")
                : t("analytics:insights.requestPaceWithRequests", { count: requestCount })}
            </p>
          </article>
          <article className="analytics-insight">
            <div className="analytics-insight__header">
              <ShieldCheck size={16} />
              <strong>{t("analytics:insights.exchangeCompletionTitle")}</strong>
            </div>
            <p>
              {successfulExchanges >= failedExchanges + deniedExchanges
                ? t("analytics:insights.exchangeHealthy")
                : t("analytics:insights.exchangeUnhealthy")}
            </p>
          </article>
          <article className="analytics-insight">
            <div className="analytics-insight__header">
              <Activity size={16} />
              <strong>{t("analytics:insights.agentActivityTitle")}</strong>
            </div>
            <p>
              {activeAgents?.active_agents
                ? t("analytics:insights.agentActivityActive", { count: activeAgents.active_agents, hours: activeAgents.hours })
                : t("analytics:insights.agentActivityNone")}
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
