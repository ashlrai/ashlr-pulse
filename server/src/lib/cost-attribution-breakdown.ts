/**
 * cost-attribution-breakdown.ts — cost attribution by source and model tier.
 *
 * Answers "what's our Cursor vs Claude Code spend ratio?" by grouping
 * activity_event rows over a date range by source and model, applying
 * subscription-mode zeroing, and returning aggregates ready for charts.
 *
 * Privacy floor: queries only the aggregate numbers — no prompts,
 * completions, or code content.
 *
 * Subscription-mode zeroing: sources listed in subscriptionSources have
 * their cost zeroed (the user pays a flat subscription rather than per-token).
 * Token counts are NEVER zeroed — only cost.
 *
 * Unknown models: rows without a known price produce cost_cents = null.
 * They are still counted in events/tokens so "unknown" appears as a model
 * with a real token footprint but no dollar attribution.
 */

import {
  costMillicents,
  millicentsToCents,
  normalizeModel,
} from "@/lib/pricing";

// ── CSV column contract ───────────────────────────────────────────────────────

/** Stable column order for the CSV export. Must not change between releases. */
export const ATTRIBUTION_CSV_COLUMNS = [
  "type",           // "source" | "model"
  "key",            // source name or model id
  "events",         // event count
  "tokens",         // billable tokens (input + output + reasoning)
  "cost_usd",       // cost in USD (0 for subscription sources)
  "cost_share_pct", // percentage of total attributed cost
] as const;

export type AttributionCsvColumn = (typeof ATTRIBUTION_CSV_COLUMNS)[number];

// ── Public types ──────────────────────────────────────────────────────────────

/** Attribution row for one source (e.g. "claude_code", "cursor"). */
export interface SourceAttributionRow {
  source: string;
  events: number;
  tokens: number;
  /** Cost in integer cents. null when no priced events for this source. */
  cost_cents: number | null;
  /** 0–1 share of total attributed cost. 0 when total is 0. */
  cost_share: number;
}

/** Attribution row for one model (e.g. "claude-sonnet-4-6", "gpt-4o"). */
export interface ModelAttributionRow {
  model: string;
  events: number;
  tokens: number;
  /** Cost in integer cents. null when model is unknown/unpriced. */
  cost_cents: number | null;
  /** 0–1 share of total attributed cost. 0 when total is 0. */
  cost_share: number;
}

export interface CostAttributionBreakdown {
  /** Per-source breakdown, ordered by cost_cents desc (nulls last). */
  bySource: SourceAttributionRow[];
  /** Per-model breakdown, ordered by cost_cents desc (nulls last). */
  byModel: ModelAttributionRow[];
  /** Total cost in integer cents across all attributed sources. */
  total_cents: number;
  /** ISO date of the earliest event included. */
  since: string | null;
  /** ISO date of the latest event included. */
  until: string | null;
}

// ── Raw event shape (subset of activity_event columns we need) ────────────────

interface RawAttribEvent {
  ts: string;
  source: string;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  cost_millicents: number | bigint | string | null;
}

// ── Query options ──────────────────────────────────────────────────────────────

export interface AttributionQueryOpts {
  userId: string;
  /** ISO-8601 lower bound (inclusive). Defaults to 30 days ago. */
  sinceISO?: string | null;
  /** ISO-8601 upper bound (exclusive). Defaults to now. */
  untilISO?: string | null;
  /** Sources with flat subscriptions — their cost_cents is zeroed. */
  subscriptionSources?: Set<string>;
  /** Optional source filter — restrict to one source. */
  sourceFilter?: string | null;
}

// ── Main function ──────────────────────────────────────────────────────────────

/**
 * Compute cost attribution by source and model for the given user + window.
 *
 * Pure in-memory aggregation: fetches the minimal set of columns from
 * activity_event, applies subscription zeroing, and builds the breakdown.
 * No LLM, no external calls.
 */
export async function loadCostAttributionBreakdown(
  opts: AttributionQueryOpts,
): Promise<CostAttributionBreakdown> {
  const { sql } = await import("@/lib/db");
  const db = sql();

  const sinceParam = opts.sinceISO ?? null;
  const untilParam = opts.untilISO ?? null;
  const sourceParam = opts.sourceFilter ?? null;

  const rows = await db.unsafe<RawAttribEvent[]>(
    `
    SELECT
      ts::text                AS ts,
      source,
      model,
      tokens_input,
      tokens_output,
      tokens_reasoning,
      tokens_cache_read,
      tokens_cache_write,
      tokens_cache_5m_write,
      tokens_cache_1h_write,
      cost_millicents
    FROM activity_event
    WHERE user_id = $1::uuid
      AND ts >= COALESCE($2::timestamptz, NOW() - INTERVAL '30 days')
      AND ($3::timestamptz IS NULL OR ts < $3::timestamptz)
      AND ($4::text IS NULL OR source = $4::text)
    ORDER BY ts ASC
    `,
    [opts.userId, sinceParam, untilParam, sourceParam],
  );

  return computeAttribution(rows, opts.subscriptionSources ?? new Set());
}

// ── Pure aggregation (exported for testing without a DB) ──────────────────────

/**
 * Aggregate raw event rows into the attribution breakdown.
 * Exported so tests can call it directly with synthetic data.
 */
export function computeAttribution(
  rows: RawAttribEvent[],
  subscriptionSources: Set<string>,
): CostAttributionBreakdown {
  // source → accumulator
  const sourceMap = new Map<string, { events: number; tokens: number; millicents: number | null }>();
  // model (normalized) → accumulator
  const modelMap = new Map<string, { events: number; tokens: number; millicents: number | null }>();

  let minTs: string | null = null;
  let maxTs: string | null = null;

  for (const e of rows) {
    // Track date range
    if (!minTs || e.ts < minTs) minTs = e.ts;
    if (!maxTs || e.ts > maxTs) maxTs = e.ts;

    const billable =
      (e.tokens_input ?? 0) +
      (e.tokens_output ?? 0) +
      (e.tokens_reasoning ?? 0);

    // Compute cost in millicents — use cached column when available,
    // fall back to recompute (same strategy as dashboard-data.ts).
    const rawMillicents = resolveEventMillicents(e);
    // Apply subscription zeroing: flat-subscription sources cost $0.
    const millicents = subscriptionSources.has(e.source) ? 0 : rawMillicents;

    // ── Source accumulation ──
    const srcAcc = sourceMap.get(e.source) ?? { events: 0, tokens: 0, millicents: null };
    srcAcc.events += 1;
    srcAcc.tokens += billable;
    if (millicents !== null) {
      srcAcc.millicents = (srcAcc.millicents ?? 0) + millicents;
    }
    sourceMap.set(e.source, srcAcc);

    // ── Model accumulation ──
    const modelKey = normalizeModel(e.model ?? "(unknown)");
    const mdlAcc = modelMap.get(modelKey) ?? { events: 0, tokens: 0, millicents: null };
    mdlAcc.events += 1;
    mdlAcc.tokens += billable;
    if (millicents !== null) {
      mdlAcc.millicents = (mdlAcc.millicents ?? 0) + millicents;
    }
    modelMap.set(modelKey, mdlAcc);
  }

  // Total attributed cost in millicents (sum of non-null source millicents)
  let totalMillicents = 0;
  for (const acc of sourceMap.values()) {
    if (acc.millicents !== null) totalMillicents += acc.millicents;
  }
  const total_cents = millicentsToCents(totalMillicents) ?? 0;

  // Build bySource rows
  const bySource: SourceAttributionRow[] = [...sourceMap.entries()]
    .map(([source, acc]) => {
      const cost_cents = acc.millicents !== null ? (millicentsToCents(acc.millicents) ?? 0) : null;
      return {
        source,
        events: acc.events,
        tokens: acc.tokens,
        cost_cents,
        cost_share: total_cents > 0 && cost_cents !== null ? cost_cents / total_cents : 0,
      };
    })
    .sort((a, b) => {
      // Sort by cost_cents desc, nulls last
      if (a.cost_cents === null && b.cost_cents === null) return b.events - a.events;
      if (a.cost_cents === null) return 1;
      if (b.cost_cents === null) return -1;
      return b.cost_cents - a.cost_cents;
    });

  // Build byModel rows
  const byModel: ModelAttributionRow[] = [...modelMap.entries()]
    .map(([model, acc]) => {
      const cost_cents = acc.millicents !== null ? (millicentsToCents(acc.millicents) ?? 0) : null;
      return {
        model,
        events: acc.events,
        tokens: acc.tokens,
        cost_cents,
        cost_share: total_cents > 0 && cost_cents !== null ? cost_cents / total_cents : 0,
      };
    })
    .sort((a, b) => {
      if (a.cost_cents === null && b.cost_cents === null) return b.events - a.events;
      if (a.cost_cents === null) return 1;
      if (b.cost_cents === null) return -1;
      return b.cost_cents - a.cost_cents;
    });

  return {
    bySource,
    byModel,
    total_cents,
    since: minTs ? minTs.slice(0, 10) : null,
    until: maxTs ? maxTs.slice(0, 10) : null,
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Resolve millicents for a single raw event.
 * Uses cached cost_millicents when present and valid; falls back to
 * recomputing from tokens (same strategy as resolveMillicents in dashboard-data).
 */
function resolveEventMillicents(e: RawAttribEvent): number | null {
  // Prefer cached column — already computed at ingest.
  if (e.cost_millicents != null) {
    const n = Number(e.cost_millicents);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // Fall back: recompute from tokens.
  if (!e.model) return null;
  return costMillicents({
    model: e.model,
    tokens_input: e.tokens_input,
    tokens_output: e.tokens_output,
    tokens_reasoning: e.tokens_reasoning,
    tokens_cache_read: e.tokens_cache_read,
    tokens_cache_write: e.tokens_cache_write,
    tokens_cache_5m_write: e.tokens_cache_5m_write,
    tokens_cache_1h_write: e.tokens_cache_1h_write,
    ts: new Date(e.ts),
  });
}
