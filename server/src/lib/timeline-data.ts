/**
 * timeline-data.ts — aggregation layer for the /app?tab=timeline view.
 *
 * Loads raw activity events, buckets them by UTC hour, and optionally
 * groups them by session ID (claude.session.id / ashlr.plugin.session_id).
 * Reuses the same cost/token helpers from dashboard-data so numbers are
 * consistent with what users see on the other tabs.
 *
 * Privacy floor: reads only whitelisted columns from activity_event.
 * No prompts, completions, file paths, or code content.
 */

import { sql } from "@/lib/db";
import {
  costMillicents, millicentsToCents,
} from "@/lib/pricing";
import { retentionCutoff, type PlanLimits } from "@/lib/plan-gate";
import type { ScopeFilter } from "@/lib/dashboard-data";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TimelineLoadOpts {
  /** Retention / feature limits from the user's plan. */
  limits?: PlanLimits;
  /** Filter to a single source (e.g. 'claude_code'). NULL = all sources. */
  sourceFilter?: string | null;
  /** Filter to a single repo in "org/repo" format. NULL = all repos. */
  repoFilter?: string | null;
  /** Filter to a single model id. NULL = all models. */
  modelFilter?: string | null;
  /** Filter to a single tool name (substring match against tool_calls_types). NULL = all. */
  toolFilter?: string | null;
  /** ISO-8601 lower bound. NULL = no explicit lower bound. */
  sinceISO?: string | null;
  /** ISO-8601 upper bound (exclusive). NULL = no explicit upper bound. */
  untilISO?: string | null;
  /** When true, group events into sessions using session_id. */
  groupBySession?: boolean;
  /** Filter events to a specific session_id. NULL = all sessions. */
  sessionFilter?: string | null;
  /** Sources zeroed for cost (subscription mode). */
  subscriptionSources?: Set<string>;
  /** Window size in days. Default 7. Max 30. */
  days?: number;
}

/** Single activity event as shown in the timeline feed. */
export interface TimelineEvent {
  id: string;
  ts: string;
  source: string;
  model: string | null;
  repo: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache: number | null;
  duration_ms: number | null;
  costCents: number | null;
  /** Sanitized tool-call type labels. */
  tool_calls_types: string[] | null;
  tool_calls_count: number | null;
  /** Session identifier (claude.session.id / ashlr.plugin.session_id). */
  session_id: string | null;
  fleet_event: string | null;
  fleet_outcome: string | null;
}

/** Hourly aggregation bucket for the left-gutter timeline ruler. */
export interface HourlyBucket {
  /** UTC hour string: "2026-06-17T14:00Z" */
  hour: string;
  events: number;
  tokens: number;
  costCents: number;
  /** Unique model labels seen in this hour. */
  models: string[];
  /** Event counts per source in this hour. */
  bySrc: Record<string, number>;
}

/** When groupBySession=true, events are nested under their session. */
export interface SessionGroup {
  session_id: string;
  /** ISO-8601 of the first event in the session. */
  startTs: string;
  /** ISO-8601 of the last event in the session. */
  endTs: string;
  events: number;
  tokens: number;
  costCents: number;
  models: string[];
  repos: string[];
  sources: string[];
  eventList: TimelineEvent[];
}

export interface TimelineData {
  /** Hourly buckets sorted ascending — drives the left-gutter ruler. */
  hourly: HourlyBucket[];
  /** Flat event list (when groupBySession=false or no session IDs). */
  events: TimelineEvent[];
  /** Session-grouped events (non-empty only when groupBySession=true). */
  sessions: SessionGroup[];
  /** All unique repos seen in this window (for filter chips). */
  repos: string[];
  /** All unique models seen in this window (for filter chips). */
  models: string[];
  /** All unique sources seen in this window (for filter chips). */
  sources: string[];
  /** All unique tools seen in this window (for filter chips). */
  tools: string[];
  /** Effective window in days. */
  days: number;
  /** Total cost (cents) over the window. */
  totalCostCents: number;
  /** Total billable tokens over the window. */
  totalTokens: number;
  /** Total event count over the window. */
  totalEvents: number;
}

// ─── Raw DB row ───────────────────────────────────────────────────────────────

interface RawTimelineRow {
  id: string;
  ts: string;
  source: string;
  model: string | null;
  repo_name: string | null;
  duration_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  tool_calls_count: number | null;
  tool_calls_types: string[] | null;
  cost_millicents: number | bigint | string | null;
  fleet_event: string | null;
  fleet_outcome: string | null;
  /** session_id from the metadata columns (NULL on legacy rows). */
  session_id: string | null;
}

// ─── Main loader ──────────────────────────────────────────────────────────────

const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;
/** Cap on events fetched — keeps the in-memory footprint bounded. */
const MAX_EVENTS = 2_000;

export async function loadTimeline(
  userId: string,
  scope: ScopeFilter,
  opts: TimelineLoadOpts = {},
): Promise<TimelineData> {
  const days = clampDays(opts.days ?? DEFAULT_DAYS);
  const db = sql();

  const retCutoff = opts.limits ? retentionCutoff(opts.limits) : null;
  const retParam: string | null = retCutoff ? retCutoff.toISOString() : null;
  const sourceParam = opts.sourceFilter ?? null;
  const repoParam = opts.repoFilter ?? null;
  const modelParam = opts.modelFilter ?? null;
  const sinceParam = opts.sinceISO ?? null;
  const untilParam = opts.untilISO ?? null;

  // Rebase scope placeholders to start at $8 (slots $1–$7 fixed below).
  const rebasedScopeClauseSql = rebaseScopePlaceholders(scope.repoClauseSql, 8);

  const rows = await db.unsafe<RawTimelineRow[]>(
    `
    SELECT
      id::text                  AS id,
      ts::text                  AS ts,
      source,
      model,
      repo_name,
      duration_ms,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      tokens_cache_read,
      tokens_cache_write,
      tokens_cache_5m_write,
      tokens_cache_1h_write,
      tool_calls_count,
      tool_calls_types,
      cost_millicents,
      fleet_event,
      fleet_outcome,
      session_id
    FROM activity_event
    WHERE user_id = $1
      AND ts >= NOW() - INTERVAL '${days} days'
      AND ($2::timestamptz IS NULL OR ts >= $2::timestamptz)
      AND ($3::text IS NULL OR source = $3::text)
      AND ($4::text IS NULL OR repo_name = $4::text)
      AND ($5::text IS NULL OR model = $5::text)
      AND ($6::timestamptz IS NULL OR ts >= $6::timestamptz)
      AND ($7::timestamptz IS NULL OR ts < $7::timestamptz)
      ${rebasedScopeClauseSql}
    ORDER BY ts DESC
    LIMIT ${MAX_EVENTS}
    `,
    [userId, retParam, sourceParam, repoParam, modelParam, sinceParam, untilParam, ...scope.repoParams],
  );

  // Apply session filter in-memory (consistent with loadDashboard approach).
  const filtered = opts.sessionFilter
    ? rows.filter((r) => r.session_id === opts.sessionFilter)
    : rows;

  // Apply tool filter in-memory (tool_calls_types is an array column; doing
  // this server-side avoids SQL ANY() complexity with the bind layout).
  const toolFiltered = opts.toolFilter
    ? filtered.filter(
        (r) =>
          r.tool_calls_types?.some((t) =>
            t.toLowerCase().includes(opts.toolFilter!.toLowerCase()),
          ) ?? false,
      )
    : filtered;

  return buildTimelineData(toolFiltered, opts, days);
}

// ─── In-memory aggregation ────────────────────────────────────────────────────

function buildTimelineData(
  rows: RawTimelineRow[],
  opts: TimelineLoadOpts,
  days: number,
): TimelineData {
  const subSources = opts.subscriptionSources ?? new Set<string>();

  // ── Collect metadata sets ──
  const allRepos  = new Set<string>();
  const allModels = new Set<string>();
  const allSrcs   = new Set<string>();
  const allTools  = new Set<string>();

  // ── Hourly buckets ──
  const hourlyMap = new Map<string, HourlyBucket>();

  // ── Session groups (when opted-in) ──
  const sessionMap = new Map<string, SessionGroup>();

  // ── Flat events list ──
  const events: TimelineEvent[] = [];

  let totalMillicents = 0;
  let totalTokens = 0;

  for (const r of rows) {
    const ts = new Date(r.ts);
    const mc = resolveMillicents(r, ts, subSources);
    const billable =
      (r.tokens_input ?? 0) + (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0);
    const cacheTokens =
      (r.tokens_cache_read ?? 0) +
      (r.tokens_cache_5m_write ?? 0) +
      (r.tokens_cache_1h_write ?? 0) +
      (r.tokens_cache_5m_write == null && r.tokens_cache_1h_write == null
        ? (r.tokens_cache_write ?? 0)
        : 0);

    totalMillicents += mc ?? 0;
    totalTokens += billable;

    if (r.repo_name) allRepos.add(r.repo_name);
    if (r.model)     allModels.add(r.model);
    allSrcs.add(r.source);
    if (r.tool_calls_types) for (const t of r.tool_calls_types) allTools.add(t);

    // ── Hourly bucket key = ISO truncated to hour ──
    const hourKey = ts.toISOString().slice(0, 13) + ":00Z";
    let bucket = hourlyMap.get(hourKey);
    if (!bucket) {
      bucket = { hour: hourKey, events: 0, tokens: 0, costCents: 0, models: [], bySrc: {} };
      hourlyMap.set(hourKey, bucket);
    }
    bucket.events += 1;
    bucket.tokens += billable;
    bucket.costCents += millicentsToCents(mc ?? 0) ?? 0;
    if (r.model && !bucket.models.includes(r.model)) bucket.models.push(r.model);
    bucket.bySrc[r.source] = (bucket.bySrc[r.source] ?? 0) + 1;

    // ── Flat event ──
    const ev: TimelineEvent = {
      id: r.id,
      ts: r.ts,
      source: r.source,
      model: r.model,
      repo: r.repo_name,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      tokens_cache: cacheTokens > 0 ? cacheTokens : null,
      duration_ms: r.duration_ms,
      costCents: millicentsToCents(mc),
      tool_calls_types: r.tool_calls_types,
      tool_calls_count: r.tool_calls_count,
      session_id: r.session_id,
      fleet_event: r.fleet_event,
      fleet_outcome: r.fleet_outcome,
    };
    events.push(ev);

    // ── Session grouping ──
    if (opts.groupBySession && r.session_id) {
      let sg = sessionMap.get(r.session_id);
      if (!sg) {
        sg = {
          session_id: r.session_id,
          startTs: r.ts,
          endTs: r.ts,
          events: 0,
          tokens: 0,
          costCents: 0,
          models: [],
          repos: [],
          sources: [],
          eventList: [],
        };
        sessionMap.set(r.session_id, sg);
      }
      sg.events += 1;
      sg.tokens += billable;
      sg.costCents += millicentsToCents(mc ?? 0) ?? 0;
      if (r.ts < sg.startTs) sg.startTs = r.ts;
      if (r.ts > sg.endTs)   sg.endTs   = r.ts;
      if (r.model && !sg.models.includes(r.model)) sg.models.push(r.model);
      if (r.repo_name && !sg.repos.includes(r.repo_name)) sg.repos.push(r.repo_name);
      if (!sg.sources.includes(r.source)) sg.sources.push(r.source);
      sg.eventList.push(ev);
    }
  }

  // Sort hourly buckets ascending for the timeline ruler.
  const hourly = [...hourlyMap.values()].sort((a, b) => a.hour.localeCompare(b.hour));

  // Sort sessions by most-recent start descending.
  const sessions = [...sessionMap.values()].sort((a, b) =>
    b.startTs.localeCompare(a.startTs),
  );

  return {
    hourly,
    events,
    sessions,
    repos:   [...allRepos].sort(),
    models:  [...allModels].sort(),
    sources: [...allSrcs].sort(),
    tools:   [...allTools].sort(),
    days,
    totalCostCents:  millicentsToCents(totalMillicents) ?? 0,
    totalTokens,
    totalEvents: events.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMillicents(
  r: RawTimelineRow,
  ts: Date,
  subSources: Set<string>,
): number | null {
  if (subSources.has(r.source)) return 0;
  if (r.cost_millicents != null) return Number(r.cost_millicents);
  return costMillicents({
    model:                 r.model,
    tokens_input:          r.tokens_input,
    tokens_output:         r.tokens_output,
    tokens_reasoning:      r.tokens_reasoning,
    tokens_cache_read:     r.tokens_cache_read,
    tokens_cache_write:    r.tokens_cache_write,
    tokens_cache_5m_write: r.tokens_cache_5m_write,
    tokens_cache_1h_write: r.tokens_cache_1h_write,
    ts,
  });
}

function rebaseScopePlaceholders(clauseSql: string, firstIndex: number): string {
  if (!clauseSql) return "";
  let next = firstIndex;
  return clauseSql.replace(/\$\d+/g, () => `$${next++}`);
}

function clampDays(d: number): number {
  if (!Number.isFinite(d) || d < 1) return DEFAULT_DAYS;
  if (d > MAX_DAYS) return MAX_DAYS;
  return Math.floor(d);
}

// ─── Export pure helpers for tests ───────────────────────────────────────────

export { clampDays, rebaseScopePlaceholders };

/**
 * buildHourKey — exported for unit tests.
 * Converts an ISO timestamp to its hour-bucket key.
 */
export function buildHourKey(isoTs: string): string {
  return new Date(isoTs).toISOString().slice(0, 13) + ":00Z";
}
