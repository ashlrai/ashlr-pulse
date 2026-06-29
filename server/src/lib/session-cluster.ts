/**
 * session-cluster.ts — pure function: group OTel spans into logical Claude
 * Code sessions, detect tool-call chains (read→edit→bash = "refactor chain"),
 * and return latency + token-efficiency metrics per session.
 *
 * Privacy floor: only metadata (tool names, latencies, tokens, cost) —
 * never code content or LLM output text.
 *
 * Exported for use by the /api/sessions/[id] route and tests.
 */

// ── Input shape ──────────────────────────────────────────────────────────────

/**
 * A single span from the activity_event table (or an OTLP span row).
 * Only the fields session-cluster needs — callers project these columns.
 */
export interface SpanRow {
  /** claude.session.id / ashlr.plugin.session_id. Null groups spans into
   *  a synthetic "unknown" session bucket. */
  session_id: string | null;
  /** ISO8601 timestamp of span start. */
  ts: string;
  /** Span wall-clock duration, milliseconds. Null when not reported. */
  duration_ms: number | null;
  /** Comma-separated list of tool types (claude.tool.calls_types). */
  tool_calls_types: string[] | null;
  /** Single tool name when calls_types only has one entry. */
  tool_name?: string | null;
  /** Billable input tokens. */
  tokens_input: number | null;
  /** Billable output tokens. */
  tokens_output: number | null;
  /** Reasoning tokens. */
  tokens_reasoning: number | null;
  /** Cached cost in millicents. */
  cost_millicents: number | null | bigint;
  /** Repo, used for context grouping. */
  repo_name: string | null;
  /** Source — we only cluster claude_code + ashlr_plugin spans. */
  source: string;
  /** Model identifier. */
  model: string | null;
}

// ── Output shapes ─────────────────────────────────────────────────────────────

/**
 * A single tool call within a chain — the leaf unit of analysis.
 * This is metadata-only; no code/output content ever appears here.
 */
export interface ToolCallEntry {
  /** Normalised tool name (e.g. "read", "edit", "bash"). */
  tool: string;
  /** Wall-clock duration of the span containing this tool call, ms. */
  latencyMs: number;
  /** Input tokens for this span. */
  tokensIn: number;
  /** Output tokens for this span. */
  tokensOut: number;
  /** Cost in USD cents (millicents / 1000 / 100). */
  cost: number;
}

/**
 * A named logical phase: a consecutive sub-sequence of tool calls that
 * matches a known pattern (e.g. read→edit→bash = "refactor chain").
 */
export interface ToolChainPhase {
  /** Human-readable phase label. */
  name: string;
  /** Ordered tool calls in this phase. */
  calls: ToolCallEntry[];
  /** Sum of call latencies. */
  totalLatencyMs: number;
  /** Sum of call costs. */
  totalCost: number;
}

/**
 * Result for one logical session.
 */
export interface SessionCluster {
  sessionId: string;
  /** All tool calls in chronological order. */
  toolChain: ToolCallEntry[];
  /** Detected logical phases within the session. */
  phases: ToolChainPhase[];
  /** Sum of all span latencies (ms). */
  totalLatency: number;
  /** Total cost in cents. */
  totalCost: number;
  /** Total input + output + reasoning tokens. */
  totalTokens: number;
  /** Tokens processed per millisecond (efficiency metric). */
  avgTokensPerMs: number;
  /** ISO8601 start time of the first span in this session. */
  startTs: string;
  /** ISO8601 end time of the last span in this session. */
  endTs: string;
  /** Repo this session primarily operated in (most common repo_name). */
  repo: string | null;
  /** Model used (most common in session). */
  model: string | null;
  /** Number of raw spans contributing. */
  spanCount: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Session IDs we synthesise when claude.session.id is absent. */
const UNKNOWN_SESSION = "__unknown__";

/**
 * A "refactor chain" is the minimal read → edit → bash sequence.
 * We detect any contiguous sub-sequence matching these patterns.
 */
const CHAIN_PATTERNS: Array<{ name: string; sequence: string[] }> = [
  {
    name: "refactor chain",
    sequence: ["read", "edit", "bash"],
  },
  {
    name: "read-validate loop",
    sequence: ["read", "bash", "read"],
  },
  {
    name: "read-edit loop",
    sequence: ["read", "edit", "read"],
  },
  {
    name: "write chain",
    sequence: ["read", "edit"],
  },
  {
    name: "bash chain",
    sequence: ["bash", "read"],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise a tool name from its raw value. */
function normalizeToolName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Map common Claude Code tool names to canonical short names.
  if (lower.includes("read") || lower === "view") return "read";
  if (lower.includes("edit") || lower.includes("write") || lower === "str_replace_editor") return "edit";
  if (lower === "bash" || lower === "shell" || lower === "execute") return "bash";
  if (lower.includes("search") || lower === "grep") return "grep";
  if (lower.includes("glob") || lower.includes("find")) return "glob";
  if (lower.includes("ls") || lower === "list") return "ls";
  return lower;
}

/** Extract primary tool name from a span. */
function primaryTool(span: SpanRow): string {
  if (span.tool_name) return normalizeToolName(span.tool_name);
  if (span.tool_calls_types && span.tool_calls_types.length > 0) {
    return normalizeToolName(span.tool_calls_types[0]);
  }
  return "unknown";
}

/** Millicents → USD cents. */
function millicentsToUsdCents(mc: number | null | bigint): number {
  if (mc == null) return 0;
  return Number(mc) / 1000;
}

/**
 * Detect named phases within an ordered list of ToolCallEntry items.
 *
 * Uses a greedy longest-match scan: at each position we check all
 * patterns (longest first) and consume the match if found, tagging
 * those calls as a phase. Unmatched calls are left ungrouped (no phase).
 */
function detectPhases(calls: ToolCallEntry[]): ToolChainPhase[] {
  const phases: ToolChainPhase[] = [];
  const tools = calls.map((c) => c.tool);

  // Sort patterns by sequence length descending so longest wins.
  const sorted = [...CHAIN_PATTERNS].sort(
    (a, b) => b.sequence.length - a.sequence.length,
  );

  let i = 0;
  while (i < tools.length) {
    let matched = false;
    for (const pat of sorted) {
      const len = pat.sequence.length;
      if (i + len > tools.length) continue;
      const slice = tools.slice(i, i + len);
      if (slice.every((t, idx) => t === pat.sequence[idx])) {
        const phaseCalls = calls.slice(i, i + len);
        phases.push({
          name: pat.name,
          calls: phaseCalls,
          totalLatencyMs: phaseCalls.reduce((s, c) => s + c.latencyMs, 0),
          totalCost: phaseCalls.reduce((s, c) => s + c.cost, 0),
        });
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }

  return phases;
}

/** Most-common value in an array, or null for empty. */
function mostCommon<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Group an array of spans into `SessionCluster[]`, one per unique
 * `claude.session.id` (or the synthetic `__unknown__` bucket).
 *
 * Spans are sorted chronologically within each session before analysis.
 * The returned array is sorted by `totalCost` descending so callers
 * can take the top-N most expensive sessions.
 *
 * Only spans from `claude_code` or `ashlr_plugin` sources are included;
 * git / shell / fleet spans are excluded because they don't carry
 * tool-call metadata.
 */
export function clusterSpansBySession(spans: SpanRow[]): SessionCluster[] {
  // Group by session_id.
  const groups = new Map<string, SpanRow[]>();
  for (const span of spans) {
    // Only cluster agent spans.
    if (span.source !== "claude_code" && span.source !== "ashlr_plugin") continue;
    const key = span.session_id ?? UNKNOWN_SESSION;
    const list = groups.get(key) ?? [];
    list.push(span);
    groups.set(key, list);
  }

  const clusters: SessionCluster[] = [];

  for (const [sessionId, rows] of groups) {
    // Sort chronologically.
    rows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    const toolChain: ToolCallEntry[] = rows.map((span) => ({
      tool: primaryTool(span),
      latencyMs: span.duration_ms ?? 0,
      tokensIn: span.tokens_input ?? 0,
      tokensOut: (span.tokens_output ?? 0) + (span.tokens_reasoning ?? 0),
      cost: millicentsToUsdCents(span.cost_millicents),
    }));

    const phases = detectPhases(toolChain);

    const totalLatency = toolChain.reduce((s, c) => s + c.latencyMs, 0);
    const totalCost = toolChain.reduce((s, c) => s + c.cost, 0);
    const totalTokens = toolChain.reduce((s, c) => s + c.tokensIn + c.tokensOut, 0);
    const avgTokensPerMs = totalLatency > 0 ? totalTokens / totalLatency : 0;

    clusters.push({
      sessionId,
      toolChain,
      phases,
      totalLatency,
      totalCost,
      totalTokens,
      avgTokensPerMs,
      startTs: rows[0].ts,
      endTs: rows[rows.length - 1].ts,
      repo: mostCommon(rows.map((r) => r.repo_name).filter((r): r is string => r != null)),
      model: mostCommon(rows.map((r) => r.model).filter((m): m is string => m != null)),
      spanCount: rows.length,
    });
  }

  // Sort by cost descending (most expensive session first).
  return clusters.sort((a, b) => b.totalCost - a.totalCost);
}
