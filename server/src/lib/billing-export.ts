/**
 * billing-export.ts — engagement billing export: aggregation + CSV generation.
 *
 * Aggregates activity_event rows for a given project + date range into daily
 * buckets per (repo, model, day). Computes "hours worked" as the wall-clock
 * span between the first and last event timestamp for that (day, repo),
 * capped at 8 hours.
 *
 * Privacy floor: only SHAREABLE_FIELDS are used — no prompts, completions,
 * or raw OTel spans. Columns: ts, repo_name, model, tokens_input,
 * tokens_output, cost_millicents, event count.
 *
 * CSV columns (BILLING_CSV_COLUMNS — must stay stable across releases):
 *   date | repo | model | hours_worked | tokens_input | tokens_output |
 *   cost_usd | event_count
 */

import { sql } from "./db";

// ---------------------------------------------------------------------------
// Column contract (must match the CSV header in the export route).
// ---------------------------------------------------------------------------

export const BILLING_CSV_COLUMNS = [
  "date",
  "repo",
  "model",
  "hours_worked",
  "tokens_input",
  "tokens_output",
  "cost_usd",
  "event_count",
] as const;

export type BillingCsvColumn = (typeof BILLING_CSV_COLUMNS)[number];

/** Cap on hours-worked per (day, repo) — 8 hours. */
export const HOURS_CAP = 8;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** One row returned by the aggregation query. */
interface BillingAggRow {
  day: string;
  repo: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
  cost_millicents: number;
  event_count: number;
  /** ISO timestamp of the first event in this (day, repo, model) bucket. */
  first_ts: string;
  /** ISO timestamp of the last event in this (day, repo, model) bucket. */
  last_ts: string;
}

/** One normalised export record (matches BILLING_CSV_COLUMNS). */
export interface BillingExportRecord {
  date: string;
  repo: string;
  model: string;
  /**
   * Wall-clock hours between first and last event on this (day, repo),
   * capped at HOURS_CAP (8h). The cap flag is carried alongside so the
   * UI can render a tooltip.
   */
  hours_worked: number;
  /** true when the raw wall-clock span exceeded HOURS_CAP and was clamped. */
  hours_capped: boolean;
  tokens_input: number;
  tokens_output: number;
  /** Cost in USD, rounded to 6 decimal places. Never NaN or null. */
  cost_usd: number;
  event_count: number;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface BillingExportQuery {
  projectId: string;
  sinceISO: string;
  untilISO: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert millicents to USD, rounded to 6 decimal places.
 * Accepts number | bigint | string | null — returns 0 for any bad value
 * so money columns are never NaN or null in the export.
 */
export function millicentsToUsd(v: number | bigint | string | null | undefined): number {
  if (v == null) return 0;
  const n =
    typeof v === "bigint" ? Number(v) :
    typeof v === "string" ? Number(v) :
    v;
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 100_000) * 1_000_000) / 1_000_000;
}

/**
 * Compute wall-clock hours between firstTs and lastTs, capped at HOURS_CAP.
 * Returns { hours, capped } where capped=true when the raw value exceeded the cap.
 *
 * Edge-cases:
 *   • Invalid / missing timestamps → 0h, not capped.
 *   • negative diff (clock skew) → 0h, not capped.
 *   • diff == 0 (single event) → 0h, not capped.
 */
export function computeHours(
  firstTs: string | null | undefined,
  lastTs: string | null | undefined,
): { hours: number; capped: boolean } {
  if (!firstTs || !lastTs) return { hours: 0, capped: false };
  const t0 = new Date(firstTs).getTime();
  const t1 = new Date(lastTs).getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return { hours: 0, capped: false };
  const diffMs = t1 - t0;
  if (diffMs <= 0) return { hours: 0, capped: false };
  const rawHours = diffMs / 3_600_000;
  if (rawHours > HOURS_CAP) {
    return { hours: HOURS_CAP, capped: true };
  }
  // Round to 2 decimal places for display clarity.
  return { hours: Math.round(rawHours * 100) / 100, capped: false };
}

// ---------------------------------------------------------------------------
// Aggregation query
// ---------------------------------------------------------------------------

/**
 * Aggregate activity_event rows for the given project + date range into daily
 * buckets per (repo, model, day). Returns one BillingExportRecord per bucket,
 * ordered by date ASC, repo ASC, model ASC.
 *
 * The query joins project_repo so only events from repos belonging to the
 * project are included — preventing cross-project data leakage.
 *
 * Note: hours_worked is computed per (day, repo) not per (day, repo, model)
 * because wall-clock time is a property of the developer session, not the
 * model used. We use the min/max ts across all models for that (day, repo)
 * bucket to derive hours, but still report per-model token/cost breakdowns.
 */
export async function aggregateBillingExport(
  query: BillingExportQuery,
): Promise<BillingExportRecord[]> {
  const db = sql();

  // Parse + validate dates defensively — fall back to wide bounds on error.
  const since = parseIsoOrFallback(query.sinceISO, new Date(0).toISOString());
  const until = parseIsoOrFallback(query.untilISO, new Date().toISOString());

  // Step 1: fetch daily (repo, model) aggregates plus per-(day, repo) min/max ts
  // for the hours-worked calculation.
  const rows = await db.unsafe<BillingAggRow[]>(
    `
    WITH daily AS (
      SELECT
        to_char(date_trunc('day', ae.ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        ae.repo_name                                                         AS repo,
        COALESCE(ae.model, '(unknown)')                                      AS model,
        COALESCE(SUM(COALESCE(ae.tokens_input,  0)), 0)::bigint              AS tokens_input,
        COALESCE(SUM(COALESCE(ae.tokens_output, 0)), 0)::bigint              AS tokens_output,
        COALESCE(SUM(COALESCE(ae.cost_millicents, 0)), 0)::bigint            AS cost_millicents,
        COUNT(*)::int                                                         AS event_count,
        -- Per (day, repo) wall-clock span — used for hours-worked calculation.
        -- Must be computed at the (day, repo) level, not (day, repo, model),
        -- because the developer session spans all models.
        MIN(ae.ts) OVER (
          PARTITION BY date_trunc('day', ae.ts AT TIME ZONE 'UTC'), ae.repo_name
        )::text                                                               AS first_ts,
        MAX(ae.ts) OVER (
          PARTITION BY date_trunc('day', ae.ts AT TIME ZONE 'UTC'), ae.repo_name
        )::text                                                               AS last_ts
      FROM activity_event ae
      JOIN project_repo pr
        ON pr.repo_name   = ae.repo_name
       AND pr.project_id  = $1::uuid
      WHERE ae.ts >= $2::timestamptz
        AND ae.ts <= $3::timestamptz
        AND ae.repo_name IS NOT NULL
    )
    SELECT
      day,
      repo,
      model,
      SUM(tokens_input)::bigint    AS tokens_input,
      SUM(tokens_output)::bigint   AS tokens_output,
      SUM(cost_millicents)::bigint AS cost_millicents,
      SUM(event_count)::int        AS event_count,
      -- first_ts / last_ts are the same for all models in a (day, repo) — pick any.
      MIN(first_ts)                AS first_ts,
      MAX(last_ts)                 AS last_ts
    FROM daily
    GROUP BY day, repo, model
    ORDER BY day ASC, repo ASC, model ASC
    `,
    [query.projectId, since, until],
  );

  return rows.map((row) => {
    const { hours, capped } = computeHours(row.first_ts, row.last_ts);
    return {
      date: row.day,
      repo: row.repo,
      model: row.model,
      hours_worked: hours,
      hours_capped: capped,
      tokens_input: typeof row.tokens_input === "bigint"
        ? Number(row.tokens_input) : Number(row.tokens_input ?? 0),
      tokens_output: typeof row.tokens_output === "bigint"
        ? Number(row.tokens_output) : Number(row.tokens_output ?? 0),
      cost_usd: millicentsToUsd(row.cost_millicents),
      event_count: Number(row.event_count ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// CSV serialisation
// ---------------------------------------------------------------------------

/** Render the CSV header line. */
export function billingCsvHeader(): string {
  return BILLING_CSV_COLUMNS.join(",");
}

/** Escape a single value for RFC 4180 CSV. */
function csvCell(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Render one BillingExportRecord as a CSV data row (no trailing newline). */
export function billingCsvRow(rec: BillingExportRecord): string {
  return BILLING_CSV_COLUMNS.map((col) => csvCell(rec[col])).join(",");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIsoOrFallback(iso: string, fallback: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}
