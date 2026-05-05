/**
 * otel-genai.ts — map an OpenTelemetry GenAI span to our activity_event row.
 *
 * We accept OTLP/HTTP (JSON). The Claude Code OTel exporter emits spans
 * whose attributes follow the GenAI semantic conventions:
 *
 *   gen_ai.system                   -> provider
 *   gen_ai.request.model            -> model
 *   gen_ai.usage.input_tokens       -> tokens_input
 *   gen_ai.usage.output_tokens      -> tokens_output
 *   gen_ai.usage.reasoning_tokens   -> tokens_reasoning      (extended thinking)
 *   gen_ai.usage.cache_read_tokens     -> tokens_cache_read     (Anthropic)
 *   gen_ai.usage.cache_write_tokens    -> tokens_cache_write    (legacy flat)
 *   gen_ai.usage.cache_5m_write_tokens -> tokens_cache_5m_write (5-min ephemeral)
 *   gen_ai.usage.cache_1h_write_tokens -> tokens_cache_1h_write (1-hour ephemeral)
 *
 * The 5m/1h split lets us price each tier accurately (1.25× vs 2× input).
 * The flat cache_write field is still emitted for backwards compat — pricing
 * falls back to billing it at the conservative 1h rate when split is absent.
 *
 * Plus Claude Code private attributes prefixed `claude.`:
 *
 *   claude.tool.calls_count
 *   claude.tool.calls_types         (comma-separated)
 *   claude.session.id
 *   claude.project.hash
 *   claude.repo.name
 *   claude.git.branch
 *   claude.language
 *
 * And ashlr-plugin attributes prefixed `ashlr.plugin.`:
 *
 *   ashlr.plugin.tokens_saved       -> tokens_saved
 *   ashlr.plugin.session_id         -> session_id (overrides claude.session.id)
 *   ashlr.plugin.repo               -> repo_name  (overrides claude.repo.name)
 *   ashlr.plugin.savings.genome     -> tokens_saved_breakdown.genome     (int)
 *   ashlr.plugin.savings.snipcompact -> tokens_saved_breakdown.snipcompact (int)
 *   ashlr.plugin.savings.route      -> tokens_saved_breakdown.route      (int)
 *   ashlr.plugin.feature_flags      -> plugin_features (TEXT[]; CSV input)
 *   ashlr.plugin.version            -> plugin_version  (semver string)
 *   ashlr.plugin.genome_hit_rate    -> plugin_genome_hit_rate (0..1 float)
 *
 * The plugin emitter sets `gen_ai.system` so plugin spans pass the
 * GenAI-shape gate; but we override `source` to `ashlr_plugin` so the
 * UI can distinguish where data came from.
 *
 * Source label override:
 *
 *   ashlr.source  — when present, overrides the auto-derived source label.
 *                   Must be one of: 'claude_code' | 'cursor' | 'copilot' |
 *                   'wakatime' | 'git' | 'shell' | 'ashlr_plugin'.
 *                   Used by the pulse-agent to tag git-commit spans as "git".
 *
 * Unknown / missing attributes map to NULL — the schema is designed for
 * partial data from heterogeneous sources.
 */

import { createHash } from "node:crypto";
import { costMillicents, PRICE_VERSION } from "./pricing";
import type { OtlpSpan, OtlpSpanAttribute } from "./otlp-types";

export interface ActivityEventInsert {
  ts: string;             // ISO8601
  user_id: string;
  session_id: string | null;
  source: string;
  provider: string | null;
  model: string | null;
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
  accepted_count: number | null;
  rejected_count: number | null;
  project_hash: string | null;
  repo_name: string | null;
  git_branch: string | null;
  language: string | null;
  tokens_saved: number | null;
  tokens_saved_breakdown: Record<string, number> | null;
  plugin_features: string[] | null;
  plugin_version: string | null;
  plugin_genome_hit_rate: number | null;
  /** OTLP spanId (16-byte hex) — used for idempotency on retries. May be
   *  null for legacy clients that don't set it. */
  span_id: string | null;
  /** Cached cost at ingest time, in millicents. Avoids re-pricing on
   *  every dashboard read. NULL only if model is unknown. */
  cost_millicents: number | null;
  /** Rate-table revision used to compute cost_millicents. Lets us
   *  re-price old rows when the table changes. NULL when uncached. */
  pricing_version: number | null;
  /** Content hash for null-span-id dedup. SHA-256 of
   *  (user_id, ts-second, model, tokens_in, tokens_out, repo, source). */
  dedup_key: string | null;
  raw_otel_span: unknown;
}

function attrValue(a: OtlpSpanAttribute): string | number | boolean | null {
  const v = a.value;
  if (!v) return null;
  if ("stringValue" in v && v.stringValue !== undefined) return v.stringValue;
  if ("intValue" in v && v.intValue !== undefined) return Number(v.intValue);
  if ("doubleValue" in v && v.doubleValue !== undefined) return v.doubleValue;
  if ("boolValue" in v && v.boolValue !== undefined) return v.boolValue;
  return null;
}

function attrMap(span: OtlpSpan): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>();
  for (const a of span.attributes ?? []) {
    const v = attrValue(a);
    if (v !== null) m.set(a.key, v);
  }
  return m;
}

function asString(m: Map<string, unknown>, k: string): string | null {
  const v = m.get(k);
  return typeof v === "string" ? v : null;
}
function asInt(m: Map<string, unknown>, k: string): number | null {
  const v = m.get(k);
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
function asFloat(m: Map<string, unknown>, k: string): number | null {
  const v = m.get(k);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Truncate ISO8601 timestamp to second resolution — the dedup key
 * must collapse twin-emission within the same second but not events
 * one full second apart.
 */
function tsSecond(iso: string): string {
  return iso.slice(0, 19); // "2026-05-04T21:12:55"
}

/**
 * Produce the content-hash dedup key. Must stay in lock-step with the
 * SQL formula in db/migrations/0018_dedup_content_only.sql or
 * backfilled dedup_keys won't collide with newly-ingested ones.
 *
 * Content-only: 0017 added session_id and that over-discriminated
 * (cmux mints a fresh session_id per shell, so duplicates never
 * collapsed). The token columns provide enough specificity to keep
 * genuinely distinct sessions distinct — they differ in at least
 * the cache_read / 5m / 1h pattern.
 */
function makeDedupKey(
  userId: string,
  ts: string,
  model: string | null,
  tokensIn: number | null,
  tokensOut: number | null,
  tokensReasoning: number | null,
  tokensCacheRead: number | null,
  tokensCache5m: number | null,
  tokensCache1h: number | null,
  tokensCacheWriteLegacy: number | null,
  repo: string | null,
  source: string,
): string {
  const canonical = [
    userId,
    tsSecond(ts),
    model ?? "",
    String(tokensIn ?? 0),
    String(tokensOut ?? 0),
    String(tokensReasoning ?? 0),
    String(tokensCacheRead ?? 0),
    String(tokensCache5m ?? 0),
    String(tokensCache1h ?? 0),
    String(tokensCacheWriteLegacy ?? 0),
    repo ?? "",
    source,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Map one span to one activity_event row, or return null if the span does
 * not represent a GenAI-shaped event we recognize. Accepts no user_id
 * because that's always overlaid by the ingest route from the auth
 * context — callers supply it.
 */
export function spanToActivityEvent(
  span: OtlpSpan,
  userId: string,
): ActivityEventInsert | null {
  const attrs = attrMap(span);

  // Only map spans that carry GenAI / claude / ashlr-plugin attributes.
  // Anything else (vanilla HTTP spans, etc.) is ignored — we're not a
  // general OTel backend.
  const provider = asString(attrs, "gen_ai.system");
  const keys = [...attrs.keys()];
  const hasClaude = keys.some((k) => k.startsWith("claude."));
  const hasPlugin = keys.some((k) => k.startsWith("ashlr.plugin."));
  if (!provider && !hasClaude && !hasPlugin) return null;

  const startNs = span.startTimeUnixNano;
  const endNs = span.endTimeUnixNano;
  const ts =
    startNs !== undefined
      ? new Date(Number(BigInt(startNs) / 1_000_000n)).toISOString()
      : new Date().toISOString();
  const durationMs =
    startNs !== undefined && endNs !== undefined
      ? Number((BigInt(endNs) - BigInt(startNs)) / 1_000_000n)
      : null;

  const toolTypesRaw = asString(attrs, "claude.tool.calls_types");
  const toolTypes = toolTypesRaw
    ? toolTypesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  // ashlr.source overrides automatic detection. Validated against the known
  // enum so arbitrary strings can't slip through to the DB.
  const ALLOWED_SOURCES = new Set([
    "claude_code", "cursor", "copilot", "wakatime", "git", "shell", "ashlr_plugin",
  ]);
  const sourceOverride = asString(attrs, "ashlr.source");
  const source = sourceOverride && ALLOWED_SOURCES.has(sourceOverride)
    ? sourceOverride
    : hasPlugin
      ? "ashlr_plugin"
      : hasClaude
        ? "claude_code"
        : provider ?? "unknown";

  const tokensInput = asInt(attrs, "gen_ai.usage.input_tokens");
  const tokensOutput = asInt(attrs, "gen_ai.usage.output_tokens");
  const tokensReasoning = asInt(attrs, "gen_ai.usage.reasoning_tokens");
  const tokensCacheRead = asInt(attrs, "gen_ai.usage.cache_read_tokens");
  const tokensCacheWrite = asInt(attrs, "gen_ai.usage.cache_write_tokens");
  const tokensCache5m = asInt(attrs, "gen_ai.usage.cache_5m_write_tokens");
  const tokensCache1h = asInt(attrs, "gen_ai.usage.cache_1h_write_tokens");
  const model = asString(attrs, "gen_ai.request.model")
    ?? asString(attrs, "gen_ai.response.model");
  const repoName =
    asString(attrs, "ashlr.plugin.repo") ??
    asString(attrs, "claude.repo.name");

  // Plugin per-feature savings breakdown — only build the JSONB
  // object if at least one of the keys was emitted, so a span with
  // no plugin signals stays NULL (not {}).
  const savingsGenome     = asInt(attrs, "ashlr.plugin.savings.genome");
  const savingsSnip       = asInt(attrs, "ashlr.plugin.savings.snipcompact");
  const savingsRoute      = asInt(attrs, "ashlr.plugin.savings.route");
  const savings: Record<string, number> = {};
  if (savingsGenome != null) savings.genome = savingsGenome;
  if (savingsSnip   != null) savings.snipcompact = savingsSnip;
  if (savingsRoute  != null) savings.route = savingsRoute;
  const tokensSavedBreakdown = Object.keys(savings).length > 0 ? savings : null;

  // Plugin feature flags — CSV in, TEXT[] out.
  const featureFlagsRaw = asString(attrs, "ashlr.plugin.feature_flags");
  const pluginFeatures = featureFlagsRaw
    ? featureFlagsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  // Cache cost at ingest — stop recomputing 30k rows on every read.
  // NULL when model is unknown; read path will render "—" or fall back.
  const millicents = costMillicents({
    model,
    tokens_input:          tokensInput,
    tokens_output:         tokensOutput,
    tokens_reasoning:      tokensReasoning,
    tokens_cache_read:     tokensCacheRead,
    tokens_cache_write:    tokensCacheWrite,
    tokens_cache_5m_write: tokensCache5m,
    tokens_cache_1h_write: tokensCache1h,
    ts: new Date(ts),
  });

  const sessionId =
    asString(attrs, "ashlr.plugin.session_id") ??
    asString(attrs, "claude.session.id");
  const dedupKey = makeDedupKey(
    userId, ts, model,
    tokensInput, tokensOutput, tokensReasoning,
    tokensCacheRead, tokensCache5m, tokensCache1h, tokensCacheWrite,
    repoName, source,
  );

  return {
    ts,
    user_id: userId,
    session_id: sessionId,
    source,
    provider,
    model,
    duration_ms: durationMs,
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    tokens_reasoning: tokensReasoning,
    tokens_cache_read: tokensCacheRead,
    tokens_cache_write: tokensCacheWrite,
    tokens_cache_5m_write: tokensCache5m,
    tokens_cache_1h_write: tokensCache1h,
    tool_calls_count: asInt(attrs, "claude.tool.calls_count"),
    tool_calls_types: toolTypes,
    accepted_count: asInt(attrs, "claude.edits.accepted_count"),
    rejected_count: asInt(attrs, "claude.edits.rejected_count"),
    project_hash: asString(attrs, "claude.project.hash"),
    repo_name: repoName,
    git_branch: asString(attrs, "claude.git.branch"),
    language: asString(attrs, "claude.language"),
    tokens_saved: asInt(attrs, "ashlr.plugin.tokens_saved"),
    tokens_saved_breakdown: tokensSavedBreakdown,
    plugin_features: pluginFeatures,
    plugin_version: asString(attrs, "ashlr.plugin.version"),
    plugin_genome_hit_rate: asFloat(attrs, "ashlr.plugin.genome_hit_rate"),
    span_id: span.spanId ?? null,
    cost_millicents: millicents,
    pricing_version: millicents != null ? PRICE_VERSION : null,
    dedup_key: dedupKey,
    raw_otel_span: span,
  };
}
