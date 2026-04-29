/**
 * ask-pulse.ts — natural-language query engine.
 *
 * The user types a question like "show me last week's spend by repo".
 * We send Claude a constrained system prompt that asks it to emit
 * a JSON object describing a query (window, metric, group_by, filter)
 * — never raw SQL. We then translate that DSL to a typed postgres-js
 * tagged template against activity_event.
 *
 * Why a DSL instead of NL→SQL: SQL injection is real even with model
 * guardrails. By constraining outputs to an enum of group_by + metric
 * + window we get NL flexibility with zero injection surface. The
 * parameterized SQL we run is fully under our control.
 */

import { sql } from "@/lib/db";
import { complete } from "@/lib/anthropic";
import { costUsdCents, fmtUsd } from "@/lib/pricing";

export type Metric =
  | "events"
  | "tokens"
  | "cost"
  | "cache_hit_ratio"
  | "tool_calls";

export type GroupBy =
  | "day"
  | "source"
  | "model"
  | "repo"
  | "tool"
  | "hour";

export interface AskQuery {
  metric: Metric;
  group_by: GroupBy;
  /** Lookback window in days. Hard-clamped 1..90. */
  window_days: number;
  /** Optional filters — same dimensions as group_by. */
  filter?: { source?: string; repo?: string; model?: string };
  /** Sort order: "value_desc" (default) | "bucket_asc" (good for time series). */
  sort?: "value_desc" | "bucket_asc";
  /** Top-N rows; defaults to 10 (or 30 for time series). */
  limit?: number;
}

export interface AskResult {
  query: AskQuery;
  /** Resolved series, ready to feed a chart or table. */
  rows: { label: string; value: number }[];
  /** Chart hint — the UI uses this to pick bar vs line vs donut. */
  chart: "bar" | "line" | "donut";
  /** Plain-text answer summary, optionally LLM-generated. */
  summary: string;
}

const SYSTEM = `You translate a user's question about their AI activity
data into a structured query. Respond with ONLY a JSON object — no
prose, no markdown fencing, no commentary. Schema:

{
  "metric": "events" | "tokens" | "cost" | "cache_hit_ratio" | "tool_calls",
  "group_by": "day" | "source" | "model" | "repo" | "tool" | "hour",
  "window_days": <integer 1-90>,
  "filter": { "source"?: string, "repo"?: string, "model"?: string },
  "sort": "value_desc" | "bucket_asc",
  "limit": <integer 1-50>
}

Notes:
- group_by="day" with sort="bucket_asc" for time-series questions
- group_by="hour" for "what hour do I work most" questions (returns 0-23)
- group_by="source" for "what tools" questions
- group_by="repo" for "what projects" questions
- "yesterday" → window_days=1
- "last week" → window_days=7
- "this month" → window_days=30
- "last month" → window_days=30 (we don't yet support offset windows)
- If unsure of group_by, default to "day"
- If the user asks about cost/spend, use metric="cost"
- If they ask "which" or "what is most", use sort="value_desc"`.replace(/\s+/g, " ");

export async function parseQuestion(question: string): Promise<AskQuery | null> {
  const text = await complete(SYSTEM, question, { temperature: 0, maxTokens: 200 });
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as Partial<AskQuery>;
    return validateQuery(obj);
  } catch {
    return null;
  }
}

export function validateQuery(obj: Partial<AskQuery>): AskQuery | null {
  const metricSet: Metric[] = ["events", "tokens", "cost", "cache_hit_ratio", "tool_calls"];
  const groupSet: GroupBy[] = ["day", "source", "model", "repo", "tool", "hour"];
  if (!obj.metric || !metricSet.includes(obj.metric)) return null;
  if (!obj.group_by || !groupSet.includes(obj.group_by)) return null;

  const window_days = clamp(typeof obj.window_days === "number" ? obj.window_days : 7, 1, 90);
  const limit = clamp(typeof obj.limit === "number" ? obj.limit : 10, 1, 50);
  const sort = obj.sort === "bucket_asc" ? "bucket_asc" : "value_desc";
  const filter = obj.filter && typeof obj.filter === "object"
    ? {
        source: typeof obj.filter.source === "string" ? obj.filter.source : undefined,
        repo:   typeof obj.filter.repo   === "string" ? obj.filter.repo   : undefined,
        model:  typeof obj.filter.model  === "string" ? obj.filter.model  : undefined,
      }
    : undefined;

  return { metric: obj.metric, group_by: obj.group_by, window_days, filter, sort, limit };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export async function runQuery(userId: string, q: AskQuery): Promise<AskResult> {
  const db = sql();

  // Pre-build filter as parameterized AND-clauses. Whitelist the
  // column names so an injected value can't ride into the SQL itself.
  const conds: string[] = [`user_id = $1::uuid`, `ts >= NOW() - INTERVAL '${q.window_days} days'`];
  const params: (string | number)[] = [userId];
  let pIdx = 2;
  if (q.filter?.source) { conds.push(`source = $${pIdx++}`); params.push(q.filter.source); }
  if (q.filter?.repo)   { conds.push(`repo_name = $${pIdx++}`); params.push(q.filter.repo); }
  if (q.filter?.model)  { conds.push(`model = $${pIdx++}`); params.push(q.filter.model); }
  const where = `WHERE ${conds.join(" AND ")}`;

  // Group expression: also fully whitelisted.
  const groupExpr = (() => {
    switch (q.group_by) {
      case "day":    return "DATE_TRUNC('day', ts)::date::text";
      case "hour":   return "EXTRACT(HOUR FROM ts)::int::text";
      case "source": return "COALESCE(source, '(unknown)')";
      case "model":  return "COALESCE(model, '(unspecified)')";
      case "repo":   return "COALESCE(repo_name, '(unspecified)')";
      case "tool":   return "UNNEST(COALESCE(tool_calls_types, ARRAY['(none)']::text[]))";
    }
  })();

  // Metric expression. cache_hit_ratio is computed in JS after.
  const metricExpr = (() => {
    switch (q.metric) {
      case "events":          return "COUNT(*)::bigint";
      case "tokens":          return "COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)), 0)::bigint";
      case "tool_calls":      return "COALESCE(SUM(COALESCE(tool_calls_count, 0)), 0)::bigint";
      case "cost":            return "0::bigint";              // computed in JS via costUsdCents
      case "cache_hit_ratio": return "0::bigint";              // computed in JS
    }
  })();

  // Pull raw rows when we need to compute cost / ratio in JS.
  if (q.metric === "cost" || q.metric === "cache_hit_ratio") {
    const raw = await db.unsafe<{
      bucket: string; model: string | null;
      tokens_input: number | null; tokens_output: number | null;
      tokens_cache_read: number | null; tokens_cache_write: number | null;
      tokens_cache_5m_write: number | null; tokens_cache_1h_write: number | null;
      ts: string;
    }[]>(
      `
      SELECT ${groupExpr} AS bucket, model,
             tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
             tokens_cache_5m_write, tokens_cache_1h_write,
             ts::text AS ts
      FROM activity_event
      ${where}
      `,
      params,
    );

    const buckets = new Map<string, { reads: number; writes: number; cents: number }>();
    for (const r of raw) {
      const cur = buckets.get(r.bucket) ?? { reads: 0, writes: 0, cents: 0 };
      const c = costUsdCents({
        model: r.model,
        tokens_input: r.tokens_input,
        tokens_output: r.tokens_output,
        tokens_cache_read: r.tokens_cache_read,
        tokens_cache_write: r.tokens_cache_write,
        tokens_cache_5m_write: r.tokens_cache_5m_write,
        tokens_cache_1h_write: r.tokens_cache_1h_write,
        ts: new Date(r.ts),
      });
      cur.cents += c ?? 0;
      cur.reads += r.tokens_cache_read ?? 0;
      const w = (r.tokens_cache_5m_write ?? 0) + (r.tokens_cache_1h_write ?? 0);
      cur.writes += (r.tokens_cache_5m_write == null && r.tokens_cache_1h_write == null)
        ? (r.tokens_cache_write ?? 0)
        : w;
      buckets.set(r.bucket, cur);
    }
    const rows = [...buckets.entries()]
      .map(([label, v]) => ({
        label,
        value: q.metric === "cost"
          ? v.cents / 100
          : (v.reads + v.writes === 0 ? 0 : v.reads / (v.reads + v.writes)),
      }))
      .sort((a, b) => q.sort === "bucket_asc" ? a.label.localeCompare(b.label) : b.value - a.value)
      .slice(0, q.limit ?? 10);

    return {
      query: q,
      rows,
      chart: chartFor(q),
      summary: summarize(q, rows),
    };
  }

  // Direct aggregate path.
  const out = await db.unsafe<{ label: string; value: string | number | null }[]>(
    `
    SELECT ${groupExpr} AS label, ${metricExpr} AS value
    FROM activity_event
    ${where}
    GROUP BY 1
    ORDER BY ${q.sort === "bucket_asc" ? "1 ASC" : "2 DESC NULLS LAST"}
    LIMIT ${q.limit ?? 10}
    `,
    params,
  );

  const rows = out.map((r) => ({
    label: String(r.label),
    value: typeof r.value === "string" ? Number(r.value) : (r.value ?? 0),
  }));

  return { query: q, rows, chart: chartFor(q), summary: summarize(q, rows) };
}

function chartFor(q: AskQuery): "bar" | "line" | "donut" {
  if (q.group_by === "day" || q.group_by === "hour") return "line";
  if (q.group_by === "source" || q.group_by === "model") return "donut";
  return "bar";
}

function summarize(q: AskQuery, rows: { label: string; value: number }[]): string {
  if (rows.length === 0) return "No data in that window.";
  const top = rows[0];
  const formatted = q.metric === "cost"
    ? fmtUsd(Math.round(top.value * 100))
    : q.metric === "cache_hit_ratio"
      ? `${(top.value * 100).toFixed(0)}% hit`
      : top.value.toLocaleString();
  return `${q.metric === "cost" ? "Top" : "Top"} ${q.group_by}: ${top.label} (${formatted})`;
}
