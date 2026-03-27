import type { Pool } from "pg";

export interface RequestVolumePoint {
  date: string;
  count: number;
}

export interface ExchangeMetricsPoint {
  date: string;
  successful: number;
  failed_expired: number;
  denied: number;
}

export interface AnalyticsRangeOptions {
  days?: number;
  now?: Date;
}

export interface ActiveAgentCountOptions {
  hours?: number;
  now?: Date;
}

interface RequestVolumeRow {
  day: string;
  count: string;
}

interface ExchangeMetricsRow {
  day: string;
  successful: string;
  failed_expired: string;
  denied: string;
}

interface ActiveAgentCountRow {
  count: string;
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const DEFAULT_ACTIVE_AGENT_HOURS = 24;
const MAX_ACTIVE_AGENT_HOURS = 24 * 14;

function normalizeDays(days?: number): number {
  if (!Number.isFinite(days)) {
    return DEFAULT_DAYS;
  }

  return Math.min(MAX_DAYS, Math.max(1, Math.floor(days ?? DEFAULT_DAYS)));
}

function normalizeHours(hours?: number): number {
  if (!Number.isFinite(hours)) {
    return DEFAULT_ACTIVE_AGENT_HOURS;
  }

  return Math.min(MAX_ACTIVE_AGENT_HOURS, Math.max(1, Math.floor(hours ?? DEFAULT_ACTIVE_AGENT_HOURS)));
}

export async function getRequestVolume(
  db: Pool,
  workspaceId: string,
  options: AnalyticsRangeOptions = {}
): Promise<{ days: number; series: RequestVolumePoint[] }> {
  const days = normalizeDays(options.days);
  const now = options.now ?? new Date();

  const result = await db.query<RequestVolumeRow>(
    `
      WITH day_series AS (
        SELECT generate_series(
          date_trunc('day', $2::timestamptz) - (($3::int - 1) * interval '1 day'),
          date_trunc('day', $2::timestamptz),
          interval '1 day'
        ) AS day
      ),
      request_counts AS (
        SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS count
        FROM audit_log
        WHERE workspace_id = $1
          AND event_type = 'request_created'
          AND created_at >= date_trunc('day', $2::timestamptz) - (($3::int - 1) * interval '1 day')
          AND created_at < date_trunc('day', $2::timestamptz) + interval '1 day'
        GROUP BY 1
      )
      SELECT to_char(day_series.day, 'YYYY-MM-DD') AS day, COALESCE(request_counts.count, 0)::text AS count
      FROM day_series
      LEFT JOIN request_counts ON request_counts.day = day_series.day
      ORDER BY day_series.day ASC
    `,
    [workspaceId, now.toISOString(), days]
  );

  return {
    days,
    series: result.rows.map((row) => ({
      date: row.day,
      count: Number.parseInt(row.count, 10)
    }))
  };
}

export async function getExchangeMetrics(
  db: Pool,
  workspaceId: string,
  options: AnalyticsRangeOptions = {}
): Promise<{ days: number; series: ExchangeMetricsPoint[] }> {
  const days = normalizeDays(options.days);
  const now = options.now ?? new Date();

  const result = await db.query<ExchangeMetricsRow>(
    `
      WITH day_series AS (
        SELECT generate_series(
          date_trunc('day', $2::timestamptz) - (($3::int - 1) * interval '1 day'),
          date_trunc('day', $2::timestamptz),
          interval '1 day'
        ) AS day
      ),
      exchange_counts AS (
        SELECT
          date_trunc('day', created_at) AS day,
          COUNT(*) FILTER (WHERE event_type = 'exchange_retrieved')::int AS successful,
          COUNT(*) FILTER (WHERE event_type IN ('exchange_revoked'))::int AS failed_expired,
          COUNT(*) FILTER (WHERE event_type IN ('exchange_denied', 'exchange_rejected'))::int AS denied
        FROM audit_log
        WHERE workspace_id = $1
          AND event_type IN ('exchange_retrieved', 'exchange_revoked', 'exchange_denied', 'exchange_rejected')
          AND created_at >= date_trunc('day', $2::timestamptz) - (($3::int - 1) * interval '1 day')
          AND created_at < date_trunc('day', $2::timestamptz) + interval '1 day'
        GROUP BY 1
      )
      SELECT
        to_char(day_series.day, 'YYYY-MM-DD') AS day,
        COALESCE(exchange_counts.successful, 0)::text AS successful,
        COALESCE(exchange_counts.failed_expired, 0)::text AS failed_expired,
        COALESCE(exchange_counts.denied, 0)::text AS denied
      FROM day_series
      LEFT JOIN exchange_counts ON exchange_counts.day = day_series.day
      ORDER BY day_series.day ASC
    `,
    [workspaceId, now.toISOString(), days]
  );

  return {
    days,
    series: result.rows.map((row) => ({
      date: row.day,
      successful: Number.parseInt(row.successful, 10),
      failed_expired: Number.parseInt(row.failed_expired, 10),
      denied: Number.parseInt(row.denied, 10)
    }))
  };
}

export async function getActiveAgentCount(
  db: Pool,
  workspaceId: string,
  options: ActiveAgentCountOptions = {}
): Promise<{ hours: number; count: number }> {
  const hours = normalizeHours(options.hours);
  const now = options.now ?? new Date();

  const result = await db.query<ActiveAgentCountRow>(
    `
      SELECT COUNT(DISTINCT actor_id)::text AS count
      FROM audit_log
      WHERE workspace_id = $1
        AND actor_type = 'agent'
        AND event_type = 'agent_token_minted'
        AND created_at >= $2::timestamptz - ($3::int * interval '1 hour')
        AND created_at <= $2::timestamptz
    `,
    [workspaceId, now.toISOString(), hours]
  );

  return {
    hours,
    count: Number.parseInt(result.rows[0]?.count ?? "0", 10)
  };
}
