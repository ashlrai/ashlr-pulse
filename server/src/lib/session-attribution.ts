/**
 * session-attribution.ts — pure functions: compute a cost attribution waterfall
 * for a single session, grouped by phase and tool-call type.
 *
 * Answers:
 *   1. Total session cost broken down by phase (setup / exploration /
 *      execution / review).
 *   2. Per-tool-call cost with model, tokens, duration, and repo context.
 *   3. Cost rank — which 5 tool calls consumed the most?
 *   4. Cost-per-token efficiency — identify expensive-but-low-token outliers.
 *
 * Privacy floor: only metadata (tool names, latencies, tokens, cost).
 * No code, prompts, or LLM output text ever appears here.
 *
 * All computation is pure (no DB calls). The route handler owns DB access.
 * This module is exported for testing without a DB.
 */

// ── Input shape ───────────────────────────────────────────────────────────────

/** Minimal columns projected from activity_event for attribution. */
export interface RawSessionSpan {
  ts: string;
  duration_ms: number | null;
  tool_calls_types: string[] | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  cost_millicents: number | null;
  repo_name: string | null;
  source: string;
  model: string | null;
}

// ── Output shapes ─────────────────────────────────────────────────────────────

/** The four lifecycle phases of a coding session. */
export type SessionPhase = "setup" | "exploration" | "execution" | "review";

/** A single enriched tool-call entry with full attribution metadata. */
export interface AttributedToolCall {
  /** Sequential index (0-based) within the session. */
  index: number;
  /** Normalised tool name (e.g. "read", "edit", "bash"). */
  tool: string;
  /** Phase this call was binned into. */
  phase: SessionPhase;
  /** Wall-clock duration, ms (0 when not reported). */
  durationMs: number;
  /** Input tokens for this span. */
  tokensIn: number;
  /** Output + reasoning tokens for this span. */
  tokensOut: number;
  /** Total tokens (tokensIn + tokensOut). */
  totalTokens: number;
  /** Cost in USD (cents / 100). */
  costUsd: number;
  /**
   * Cost-per-token in USD/token. Null when totalTokens === 0 (prevents ÷0).
   * Expensive-but-low-token outliers have a high value here.
   */
  costPerToken: number | null;
  /** Model used for this span. */
  model: string | null;
  /** Repo context for this span. */
  repo: string | null;
  /** Whether this is among the top-5 most expensive calls in the session. */
  isTopCost: boolean;
}

/** Aggregate for one phase. */
export interface PhaseAggregate {
  phase: SessionPhase;
  /** Number of tool calls in this phase. */
  calls: number;
  /** Total tokens. */
  totalTokens: number;
  /** Total cost in USD. */
  totalCostUsd: number;
  /** Share of session total cost (0–1). */
  costShare: number;
}

/** Full attribution payload for one session. */
export interface SessionAttributionPayload {
  sessionId: string;
  /** All attributed tool calls in chronological order. */
  toolCalls: AttributedToolCall[];
  /** Per-phase aggregates. */
  phaseAggregates: PhaseAggregate[];
  /** Top 5 most expensive tool calls (by costUsd desc). */
  topCostCalls: AttributedToolCall[];
  /**
   * Efficiency outliers: tool calls with costPerToken > 2× session median,
   * AND totalTokens < 50th-percentile token count.
   * These are "expensive but low-token" calls worth investigating.
   */
  efficiencyOutliers: AttributedToolCall[];
  /** Total session cost in USD. */
  totalCostUsd: number;
  /** Total session tokens. */
  totalTokens: number;
}

// ── CSV column contract ───────────────────────────────────────────────────────

export const ATTRIBUTION_CSV_COLUMNS = [
  "index",
  "tool",
  "phase",
  "duration_ms",
  "tokens_in",
  "tokens_out",
  "total_tokens",
  "cost_usd",
  "cost_per_token",
  "model",
  "repo",
  "is_top_cost",
] as const;

// ── Phase binning ─────────────────────────────────────────────────────────────

/**
 * Phase binning rules — applied in order; first match wins.
 *
 * "setup"       — early session orientation tools (ls, glob, tree, orient)
 * "exploration" — reading + searching + grepping
 * "execution"   — writing + editing + running (edit, bash, write)
 * "review"      — test runs, diffs, oversight, read-after-edit
 *
 * An unmatched tool defaults to "execution".
 */
const PHASE_RULES: Array<{ phase: SessionPhase; tools: Set<string> }> = [
  {
    phase: "setup",
    tools: new Set(["ls", "glob", "find", "tree", "orient", "unknown"]),
  },
  {
    phase: "exploration",
    tools: new Set(["read", "grep", "search", "webfetch", "websearch"]),
  },
  {
    phase: "review",
    tools: new Set(["diff", "test", "oversight", "audit"]),
  },
  {
    phase: "execution",
    tools: new Set(["edit", "write", "bash", "shell", "execute", "multi_edit"]),
  },
];

function binPhase(tool: string): SessionPhase {
  const t = tool.toLowerCase();
  for (const rule of PHASE_RULES) {
    if (rule.tools.has(t)) return rule.phase;
  }
  // Default: execution (covers all write-like tools not yet named)
  return "execution";
}

// ── Tool normalization ────────────────────────────────────────────────────────

function normalizeTool(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower.includes("read") || lower === "view") return "read";
  if (lower.includes("edit") || lower.includes("write") || lower === "str_replace_editor") return "edit";
  if (lower === "bash" || lower === "shell" || lower === "execute") return "bash";
  if (lower.includes("search") || lower === "grep") return "grep";
  if (lower.includes("glob") || lower.includes("find")) return "glob";
  if (lower.includes("ls") || lower === "list") return "ls";
  if (lower.includes("diff")) return "diff";
  if (lower.includes("test")) return "test";
  return lower;
}

function primaryTool(span: RawSessionSpan): string {
  if (span.tool_calls_types && span.tool_calls_types.length > 0) {
    return normalizeTool(span.tool_calls_types[0]);
  }
  return "unknown";
}

// ── Cost helpers ──────────────────────────────────────────────────────────────

/** millicents → USD (millicents / 1000 / 100 = millicents / 100000). */
function millicentsToUsd(mc: number | null): number {
  if (mc == null) return 0;
  return mc / 100_000;
}

// ── Statistics helpers ────────────────────────────────────────────────────────

/** Median of a sorted numeric array. Returns 0 for empty. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute the full cost attribution waterfall for one session.
 *
 * Pure: no DB calls. Pass raw span rows from the DB query.
 * Returns null-safe values — all numeric fields default to 0.
 */
export function computeSessionAttribution(
  sessionId: string,
  spans: RawSessionSpan[],
): SessionAttributionPayload {
  // 1. Sort spans chronologically before building tool calls so the output is
  //    always in time order even when the caller passes unsorted rows.
  const sortedSpans = [...spans].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );

  // Build attributed tool calls in chronological order.
  const raw: Omit<AttributedToolCall, "isTopCost">[] = sortedSpans.map((span, i) => {
    const tool = primaryTool(span);
    const phase = binPhase(tool);
    const tokensIn = span.tokens_input ?? 0;
    const tokensOut = (span.tokens_output ?? 0) + (span.tokens_reasoning ?? 0);
    const totalTokens = tokensIn + tokensOut;
    const costUsd = millicentsToUsd(span.cost_millicents);
    return {
      index: i,
      tool,
      phase,
      durationMs: span.duration_ms ?? 0,
      tokensIn,
      tokensOut,
      totalTokens,
      costUsd,
      costPerToken: totalTokens > 0 ? costUsd / totalTokens : null,
      model: span.model,
      repo: span.repo_name,
    };
  });

  // 2. Identify top-5 most expensive calls.
  const sortedByCost = [...raw].sort((a, b) => b.costUsd - a.costUsd);
  const top5Indices = new Set(sortedByCost.slice(0, 5).map((c) => c.index));

  const toolCalls: AttributedToolCall[] = raw.map((c) => ({
    ...c,
    isTopCost: top5Indices.has(c.index),
  }));

  // 3. Total cost + tokens.
  const totalCostUsd = toolCalls.reduce((s, c) => s + c.costUsd, 0);
  const totalTokens = toolCalls.reduce((s, c) => s + c.totalTokens, 0);

  // 4. Phase aggregates.
  const phaseMap = new Map<SessionPhase, { calls: number; totalTokens: number; totalCostUsd: number }>();
  const ALL_PHASES: SessionPhase[] = ["setup", "exploration", "execution", "review"];
  for (const p of ALL_PHASES) phaseMap.set(p, { calls: 0, totalTokens: 0, totalCostUsd: 0 });

  for (const c of toolCalls) {
    const acc = phaseMap.get(c.phase)!;
    acc.calls += 1;
    acc.totalTokens += c.totalTokens;
    acc.totalCostUsd += c.costUsd;
  }

  const phaseAggregates: PhaseAggregate[] = ALL_PHASES.map((phase) => {
    const acc = phaseMap.get(phase)!;
    return {
      phase,
      calls: acc.calls,
      totalTokens: acc.totalTokens,
      totalCostUsd: acc.totalCostUsd,
      costShare: totalCostUsd > 0 ? acc.totalCostUsd / totalCostUsd : 0,
    };
  });

  // 5. Top 5 cost calls (already computed, just filter + re-sort).
  const topCostCalls = toolCalls
    .filter((c) => c.isTopCost)
    .sort((a, b) => b.costUsd - a.costUsd);

  // 6. Efficiency outliers: costPerToken > 2× median, AND totalTokens below median.
  const cptValues = toolCalls
    .map((c) => c.costPerToken)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const tokenValues = [...toolCalls].map((c) => c.totalTokens).sort((a, b) => a - b);

  const medianCpt = median(cptValues);
  const medianTokens = median(tokenValues);

  const efficiencyOutliers = toolCalls.filter(
    (c) =>
      c.costPerToken !== null &&
      c.costPerToken > 2 * medianCpt &&
      c.totalTokens < medianTokens,
  );

  return {
    sessionId,
    toolCalls,
    phaseAggregates,
    topCostCalls,
    efficiencyOutliers,
    totalCostUsd,
    totalTokens,
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function csvCell(val: string | number | boolean | null): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: (string | number | boolean | null)[]): string {
  return values.map(csvCell).join(",");
}

/**
 * Render a SessionAttributionPayload as RFC 4180 CSV.
 * Exported so the route and tests can call this directly.
 */
export function attributionToCsv(payload: SessionAttributionPayload): string {
  const lines: string[] = [];
  lines.push(csvRow([...ATTRIBUTION_CSV_COLUMNS]));

  for (const c of payload.toolCalls) {
    lines.push(
      csvRow([
        c.index,
        c.tool,
        c.phase,
        c.durationMs,
        c.tokensIn,
        c.tokensOut,
        c.totalTokens,
        c.costUsd.toFixed(8),
        c.costPerToken !== null ? c.costPerToken.toFixed(10) : "",
        c.model ?? "",
        c.repo ?? "",
        c.isTopCost ? "true" : "false",
      ]),
    );
  }

  return lines.join("\n") + "\n";
}
