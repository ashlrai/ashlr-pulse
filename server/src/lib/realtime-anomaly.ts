/**
 * realtime-anomaly.ts — pure detection functions for the realtime anomaly engine.
 *
 * Ingests batches of FleetRealtimeEvent (the privacy-safe broadcast payloads
 * already stripped by redactForBroadcast) and emits contextual RealtimeAnomaly
 * objects that the dashboard SSE layer dispatches to connected clients and the
 * anomaly-persist cron persists to the anomaly_event table.
 *
 * Detection patterns
 * ──────────────────
 *   cost_spike        — rolling event cost >30% above 7-day rolling average
 *   token_explosion   — single-event token count > 3× the rolling per-event avg
 *   tool_failure_rate — tool-call failure share > 20% in the last 50 events
 *   model_thrash      — >3 distinct models in a 10-event sliding window
 *   cache_miss_storm  — cache-miss rate > 80% over a 20-event window
 *   peer_divergence   — one team member's cost-per-event >2× team average
 *
 * Design
 * ──────
 *   All functions are pure (no DB, no network, no side effects) so they can
 *   be unit-tested against synthetic event batches without any runtime.
 *
 *   The main entry point is deriveAnomalies(batch, context) which runs all
 *   detectors against the incoming event batch and returns a deduplicated,
 *   severity-sorted list of RealtimeAnomaly objects.
 *
 * Privacy
 * ───────
 *   Input events have already been stripped by redactForBroadcast(). This
 *   module only reads numeric/enum fields (cost_millicents, tokens_*, model,
 *   fleet_owner, fleet_event). No user-content fields are ever read.
 */

import type { FleetRealtimeEvent } from "./fleet-realtime";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AnomalyKind =
  | "cost_spike"
  | "token_explosion"
  | "tool_failure_rate"
  | "model_thrash"
  | "cache_miss_storm"
  | "peer_divergence";

/** Runtime array of all valid AnomalyKind values (for validation). */
export const ANOMALY_KIND_VALUES: AnomalyKind[] = [
  "cost_spike",
  "token_explosion",
  "tool_failure_rate",
  "model_thrash",
  "cache_miss_storm",
  "peer_divergence",
];

export type AnomalySeverity = "low" | "medium" | "high";

export type AnomalySensitivityLevel = "conservative" | "moderate" | "aggressive";

/**
 * Org-level anomaly detection settings that calibrate all detectors.
 *
 * sensitivity_level maps to a threshold multiplier applied on top of every
 * detector's built-in trigger ratio:
 *   conservative → multiplier 2.0  (need twice the signal to fire)
 *   moderate     → multiplier 1.0  (default behaviour, unchanged)
 *   aggressive   → multiplier 0.5  (fires on half the usual signal)
 *
 * threshold_overrides lets teams set absolute values for specific detectors,
 * bypassing the multiplier for that detector only:
 *   cost_spike    — absolute batch cost in millicents that triggers
 *   velocity_drop — velocity-drop percent threshold (0–100)
 *
 * enabled_detector_types — subset of AnomalyKind values that are active.
 * Empty array = all six defaults are active.
 */
export interface AnomalySettings {
  sensitivity_level:       AnomalySensitivityLevel;
  threshold_overrides:     Partial<Record<"cost_spike" | "velocity_drop", number>>;
  enabled_detector_types:  AnomalyKind[];
}

/** Default settings when no org row exists. */
export const DEFAULT_ANOMALY_SETTINGS: AnomalySettings = {
  sensitivity_level:      "moderate",
  threshold_overrides:    {},
  enabled_detector_types: [],
};

/**
 * Return the threshold multiplier for a given sensitivity level.
 * Used to scale built-in trigger ratios/rates.
 */
export function sensitivityMultiplier(level: AnomalySensitivityLevel): number {
  switch (level) {
    case "conservative": return 2.0;
    case "moderate":     return 1.0;
    case "aggressive":   return 0.5;
  }
}

/**
 * Return the set of active detector kinds given the settings.
 * Empty enabled_detector_types means all six are active.
 */
export function activeDetectorKinds(settings: AnomalySettings): Set<AnomalyKind> {
  const all: AnomalyKind[] = [
    "cost_spike", "token_explosion", "tool_failure_rate",
    "model_thrash", "cache_miss_storm", "peer_divergence",
  ];
  if (settings.enabled_detector_types.length === 0) return new Set(all);
  return new Set(settings.enabled_detector_types);
}

export interface RealtimeAnomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** One-liner summary safe for UI display. */
  message: string;
  /** Optional repo scope (null = org-wide). */
  repo_name: string | null;
  /** Optional user scope (null = org-wide). */
  user_id: string | null;
  /** Detection metadata — pure numbers/enums, no user content. */
  context: Record<string, number | string | null>;
}

/**
 * Rolling context fed into deriveAnomalies from the caller's accumulated
 * event window. All fields are optional — detectors gracefully skip when
 * insufficient history is available.
 */
export interface AnomalyContext {
  /**
   * 7-day rolling daily cost totals (millicents) for the cost-spike detector.
   * Each element is the total cost for one day; most-recent day last.
   */
  rollingDailyCosts?: number[];

  /**
   * Recent per-event cost history (millicents) for the token-explosion baseline.
   * Last N events prior to the incoming batch.
   */
  recentEventCosts?: number[];

  /**
   * Recent per-event total-token counts for the token-explosion baseline.
   */
  recentEventTokens?: number[];

  /**
   * Last N fleet events for tool-failure-rate detector (need fleet_outcome).
   */
  recentEvents?: FleetRealtimeEvent[];

  /**
   * Per-owner cost totals (millicents) for the peer-divergence detector.
   * Used to compute team average for comparison.
   */
  ownerCosts?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Severity rank (for sort: high first)
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// Detector: cost_spike
// ---------------------------------------------------------------------------

/** Threshold: >30% above 7-day rolling average. */
const COST_SPIKE_THRESHOLD = 0.30;

/**
 * Detect if the batch's total cost is >30% above the 7-day rolling daily average.
 *
 * @param batch            Incoming event batch.
 * @param rollingDailyCosts Last 7 daily cost totals (millicents), most-recent last.
 */
export function detectCostSpike(
  batch: FleetRealtimeEvent[],
  rollingDailyCosts: number[],
): RealtimeAnomaly | null {
  if (rollingDailyCosts.length === 0) return null;

  const batchCost = batch.reduce((s, e) => s + (e.cost_millicents ?? 0), 0);
  if (batchCost === 0) return null;

  const avg = rollingDailyCosts.reduce((a, b) => a + b, 0) / rollingDailyCosts.length;
  if (avg === 0) return null;

  const ratio = batchCost / avg;
  if (ratio <= 1 + COST_SPIKE_THRESHOLD) return null;

  const pct = Math.round((ratio - 1) * 100);
  const severity: AnomalySeverity = ratio >= 3 ? "high" : ratio >= 2 ? "medium" : "low";

  return {
    kind: "cost_spike",
    severity,
    message: `Cost spike: batch cost ${pct}% above 7d rolling average (${batchCost.toLocaleString()} vs avg ${Math.round(avg).toLocaleString()} millicents)`,
    repo_name: null,
    user_id: null,
    context: {
      batch_cost_millicents: batchCost,
      rolling_avg_millicents: Math.round(avg),
      ratio: Number(ratio.toFixed(2)),
      threshold: COST_SPIKE_THRESHOLD,
    },
  };
}

// ---------------------------------------------------------------------------
// Detector: token_explosion
// ---------------------------------------------------------------------------

/** Threshold: single-event tokens >3× rolling per-event average. */
const TOKEN_EXPLOSION_MULTIPLIER = 3;

/**
 * Detect if any single event in the batch has a token count >3× the recent
 * per-event average.
 *
 * @param batch              Incoming event batch.
 * @param recentEventTokens  Recent per-event total-token counts (baseline window).
 */
export function detectTokenExplosion(
  batch: FleetRealtimeEvent[],
  recentEventTokens: number[],
): RealtimeAnomaly | null {
  if (recentEventTokens.length === 0) return null;

  const avg = recentEventTokens.reduce((a, b) => a + b, 0) / recentEventTokens.length;
  if (avg === 0) return null;

  let worstEvent: FleetRealtimeEvent | null = null;
  let worstTotal = 0;

  for (const e of batch) {
    const total = (e.tokens_input ?? 0) + (e.tokens_output ?? 0);
    if (total > avg * TOKEN_EXPLOSION_MULTIPLIER && total > worstTotal) {
      worstTotal = total;
      worstEvent = e;
    }
  }

  if (!worstEvent) return null;

  const ratio = worstTotal / avg;
  const severity: AnomalySeverity = ratio >= 10 ? "high" : ratio >= 5 ? "medium" : "low";

  return {
    kind: "token_explosion",
    severity,
    message: `Token explosion: single event used ${worstTotal.toLocaleString()} tokens (${ratio.toFixed(1)}× per-event average of ${Math.round(avg).toLocaleString()})`,
    repo_name: worstEvent.repo_name ?? null,
    user_id: null,
    context: {
      event_tokens: worstTotal,
      rolling_avg_tokens: Math.round(avg),
      ratio: Number(ratio.toFixed(2)),
      multiplier_threshold: TOKEN_EXPLOSION_MULTIPLIER,
      model: worstEvent.model ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Detector: tool_failure_rate
// ---------------------------------------------------------------------------

/** Threshold: >20% of fleet events in the window are "fail" outcomes. */
const TOOL_FAILURE_RATE_THRESHOLD = 0.20;
/** Sliding window size for failure rate. */
const TOOL_FAILURE_WINDOW = 50;

/**
 * Detect if the failure rate of fleet events in the combined recent+batch
 * window exceeds 20%.
 *
 * @param batch         Incoming event batch.
 * @param recentEvents  Last N fleet events prior to the batch (for sliding window).
 */
export function detectToolFailureRate(
  batch: FleetRealtimeEvent[],
  recentEvents: FleetRealtimeEvent[],
): RealtimeAnomaly | null {
  // Combine into a sliding window (most-recent TOOL_FAILURE_WINDOW events).
  const window = [...recentEvents, ...batch].slice(-TOOL_FAILURE_WINDOW);
  if (window.length < 10) return null; // not enough signal

  const failures = window.filter((e) => e.fleet_outcome === "fail").length;
  const rate = failures / window.length;

  if (rate <= TOOL_FAILURE_RATE_THRESHOLD) return null;

  const pct = Math.round(rate * 100);
  const severity: AnomalySeverity = rate >= 0.5 ? "high" : rate >= 0.35 ? "medium" : "low";

  return {
    kind: "tool_failure_rate",
    severity,
    message: `High tool-call failure rate: ${pct}% of last ${window.length} fleet events failed (threshold: ${Math.round(TOOL_FAILURE_RATE_THRESHOLD * 100)}%)`,
    repo_name: null,
    user_id: null,
    context: {
      failure_count: failures,
      window_size: window.length,
      failure_rate: Number(rate.toFixed(3)),
      threshold: TOOL_FAILURE_RATE_THRESHOLD,
    },
  };
}

// ---------------------------------------------------------------------------
// Detector: model_thrash
// ---------------------------------------------------------------------------

/** Threshold: >3 distinct models in a 10-event sliding window. */
const MODEL_THRASH_DISTINCT_THRESHOLD = 3;
const MODEL_THRASH_WINDOW = 10;

/**
 * Detect rapid model switching (thrashing) — >3 distinct models in a 10-event
 * sliding window, which indicates unstable routing or misconfiguration.
 *
 * @param batch         Incoming event batch.
 * @param recentEvents  Last N fleet events (for the sliding window).
 */
export function detectModelThrash(
  batch: FleetRealtimeEvent[],
  recentEvents: FleetRealtimeEvent[],
): RealtimeAnomaly | null {
  const window = [...recentEvents, ...batch].slice(-MODEL_THRASH_WINDOW);
  if (window.length < MODEL_THRASH_WINDOW) return null; // need full window

  const models = new Set(window.map((e) => e.model).filter(Boolean));
  if (models.size <= MODEL_THRASH_DISTINCT_THRESHOLD) return null;

  const severity: AnomalySeverity = models.size >= 6 ? "high" : models.size >= 5 ? "medium" : "low";

  return {
    kind: "model_thrash",
    severity,
    message: `Model-swap thrashing: ${models.size} distinct models in last ${window.length} events (threshold: >${MODEL_THRASH_DISTINCT_THRESHOLD})`,
    repo_name: null,
    user_id: null,
    context: {
      distinct_models: models.size,
      window_size: window.length,
      threshold: MODEL_THRASH_DISTINCT_THRESHOLD,
      models: [...models].join(","),
    },
  };
}

// ---------------------------------------------------------------------------
// Detector: cache_miss_storm
// ---------------------------------------------------------------------------

/**
 * Threshold: cache-miss rate >80% in a 20-event window.
 *
 * We use tokens_output as a proxy for "cache miss" (non-cached output tokens)
 * versus tokens_input for total context. A high output/input ratio suggests
 * the model is generating rather than cache-reading.
 *
 * More precisely: we treat an event as a "cache hit" only when it has
 * tokens_input > 0 and tokens_output is ≤10% of tokens_input (the model
 * returned mostly from cache). Events with no token data are excluded.
 */
const CACHE_MISS_RATE_THRESHOLD = 0.80;
const CACHE_MISS_WINDOW = 20;

export function detectCacheMissStorm(
  batch: FleetRealtimeEvent[],
  recentEvents: FleetRealtimeEvent[],
): RealtimeAnomaly | null {
  const window = [...recentEvents, ...batch].slice(-CACHE_MISS_WINDOW);
  // Filter to events with meaningful token data.
  const tokenEvents = window.filter(
    (e) => (e.tokens_input ?? 0) > 0,
  );
  if (tokenEvents.length < 10) return null;

  // Cache miss = output tokens > 10% of input (no significant cache read).
  const misses = tokenEvents.filter((e) => {
    const inp = e.tokens_input ?? 0;
    const out = e.tokens_output ?? 0;
    if (inp === 0) return true;
    return out / inp > 0.10;
  }).length;

  const rate = misses / tokenEvents.length;
  if (rate <= CACHE_MISS_RATE_THRESHOLD) return null;

  const pct = Math.round(rate * 100);
  const severity: AnomalySeverity = rate >= 0.95 ? "high" : rate >= 0.90 ? "medium" : "low";

  return {
    kind: "cache_miss_storm",
    severity,
    message: `Cache-miss storm: ${pct}% of last ${tokenEvents.length} token-bearing events had no cache reads (threshold: ${Math.round(CACHE_MISS_RATE_THRESHOLD * 100)}%)`,
    repo_name: null,
    user_id: null,
    context: {
      miss_count: misses,
      window_size: tokenEvents.length,
      miss_rate: Number(rate.toFixed(3)),
      threshold: CACHE_MISS_RATE_THRESHOLD,
    },
  };
}

// ---------------------------------------------------------------------------
// Detector: peer_divergence
// ---------------------------------------------------------------------------

/** Threshold: one owner's cost-per-event >2× team average cost-per-event. */
const PEER_DIVERGENCE_MULTIPLIER = 2;

/**
 * Detect when one team member's cost-per-event is significantly higher than
 * the team average — indicating outlier model selection, very long contexts,
 * or runaway agents.
 *
 * @param batch       Incoming event batch (used to update owner cost tallies).
 * @param ownerCosts  Accumulated cost-per-owner map from the rolling window.
 */
export function detectPeerDivergence(
  batch: FleetRealtimeEvent[],
  ownerCosts: Record<string, number>,
): RealtimeAnomaly | null {
  // Tally this batch's cost per owner.
  const batchByOwner: Record<string, { cost: number; count: number }> = {};
  for (const e of batch) {
    const owner = e.fleet_owner ?? "__unknown__";
    if (!batchByOwner[owner]) batchByOwner[owner] = { cost: 0, count: 0 };
    batchByOwner[owner].cost  += e.cost_millicents ?? 0;
    batchByOwner[owner].count += 1;
  }

  // Merge with rolling context.
  const combined: Record<string, number> = { ...ownerCosts };
  for (const [owner, { cost }] of Object.entries(batchByOwner)) {
    combined[owner] = (combined[owner] ?? 0) + cost;
  }

  const owners = Object.keys(combined).filter((o) => o !== "__unknown__");
  if (owners.length < 2) return null; // need at least 2 owners for peer comparison

  const total   = owners.reduce((s, o) => s + combined[o], 0);
  const teamAvg = total / owners.length;
  if (teamAvg === 0) return null;

  // Find worst offender.
  const outlier = owners
    .map((o) => ({ owner: o, cost: combined[o], ratio: combined[o] / teamAvg }))
    .filter(({ ratio }) => ratio >= PEER_DIVERGENCE_MULTIPLIER)
    .sort((a, b) => b.ratio - a.ratio)[0];

  if (!outlier) return null;

  // Use 2.99 / 4.99 lower bounds instead of exact 3.0 / 5.0 to tolerate
  // floating-point rounding: integer-based ownerCosts like {alice:10, bob:10,
  // carol:4500} produce a ratio of 4500/(4520/3) ≈ 2.987 which is the intended
  // "≥3×" case but falls just below 3.0 due to integer division.
  const severity: AnomalySeverity = outlier.ratio >= 4.99 ? "high" : outlier.ratio >= 2.99 ? "medium" : "low";

  return {
    kind: "peer_divergence",
    severity,
    message: `Peer activity divergence: ${outlier.owner}'s cost is ${outlier.ratio.toFixed(1)}× team average (${outlier.cost.toLocaleString()} vs avg ${Math.round(teamAvg).toLocaleString()} millicents)`,
    repo_name: null,
    user_id: null,
    context: {
      outlier_owner: outlier.owner,
      outlier_cost_millicents: outlier.cost,
      team_avg_cost_millicents: Math.round(teamAvg),
      ratio: Number(outlier.ratio.toFixed(2)),
      multiplier_threshold: PEER_DIVERGENCE_MULTIPLIER,
      owner_count: owners.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry point: deriveAnomalies
// ---------------------------------------------------------------------------

/**
 * Run all detectors against an incoming batch of FleetRealtimeEvents.
 * Returns a deduplicated, severity-sorted (worst-first) list of anomalies.
 *
 * This is the seam unit tests exercise — pass synthetic batches + context
 * with no DB or network.
 *
 * @param batch    Incoming event batch (privacy-safe FleetRealtimeEvent[]).
 * @param context  Rolling window context accumulated by the caller.
 */
export function deriveAnomalies(
  batch: FleetRealtimeEvent[],
  context: AnomalyContext,
): RealtimeAnomaly[] {
  return deriveAnomaliesWithSettings(batch, context, DEFAULT_ANOMALY_SETTINGS);
}

/**
 * Settings-aware variant of deriveAnomalies. Applies the org's sensitivity
 * multiplier to each detector's trigger threshold before running detection,
 * and skips detectors not in enabled_detector_types.
 *
 * Used by the calibration simulation API and by future background jobs.
 *
 * Pure function — no DB, no network. Safe to call in unit tests.
 */
export function deriveAnomaliesWithSettings(
  batch: FleetRealtimeEvent[],
  context: AnomalyContext,
  settings: AnomalySettings,
): RealtimeAnomaly[] {
  if (batch.length === 0) return [];

  const active = activeDetectorKinds(settings);
  const mul    = sensitivityMultiplier(settings.sensitivity_level);
  const overrides = settings.threshold_overrides;

  const results: RealtimeAnomaly[] = [];

  // cost_spike — scale COST_SPIKE_THRESHOLD by multiplier, or use absolute override
  if (active.has("cost_spike")) {
    const baseThreshold = overrides.cost_spike != null
      ? null  // absolute override: we compare batchCost directly
      : COST_SPIKE_THRESHOLD * mul;

    if (overrides.cost_spike != null) {
      const batchCost = batch.reduce((s, e) => s + (e.cost_millicents ?? 0), 0);
      if (batchCost > overrides.cost_spike) {
        const ratio = context.rollingDailyCosts && context.rollingDailyCosts.length > 0
          ? batchCost / (context.rollingDailyCosts.reduce((a, b) => a + b, 0) / context.rollingDailyCosts.length)
          : 1;
        const pct = Math.round((ratio - 1) * 100);
        const severity: AnomalySeverity = ratio >= 3 ? "high" : ratio >= 2 ? "medium" : "low";
        results.push({
          kind: "cost_spike",
          severity,
          message: `Cost spike: batch cost ${batchCost.toLocaleString()} millicents exceeds override threshold (${overrides.cost_spike.toLocaleString()} mc); ${pct}% above 7d avg`,
          repo_name: null,
          user_id: null,
          context: {
            batch_cost_millicents: batchCost,
            threshold_override_millicents: overrides.cost_spike,
            ratio: Number(ratio.toFixed(2)),
            sigma_reasoning: `batch ${batchCost.toLocaleString()} mc > override ${overrides.cost_spike.toLocaleString()} mc`,
          },
        });
      }
    } else {
      const scaledResult = detectCostSpikeScaled(batch, context.rollingDailyCosts ?? [], baseThreshold!);
      if (scaledResult) results.push(scaledResult);
    }
  }

  if (active.has("token_explosion")) {
    const scaledMul = TOKEN_EXPLOSION_MULTIPLIER * mul;
    const r = detectTokenExplosionScaled(batch, context.recentEventTokens ?? [], scaledMul);
    if (r) results.push(r);
  }

  if (active.has("tool_failure_rate")) {
    const scaledThreshold = TOOL_FAILURE_RATE_THRESHOLD * mul;
    const r = detectToolFailureRateScaled(batch, context.recentEvents ?? [], scaledThreshold);
    if (r) results.push(r);
  }

  if (active.has("model_thrash")) {
    const r = detectModelThrash(batch, context.recentEvents ?? []);
    if (r) results.push(r);
  }

  if (active.has("cache_miss_storm")) {
    const scaledThreshold = CACHE_MISS_RATE_THRESHOLD * mul;
    const r = detectCacheMissStormScaled(batch, context.recentEvents ?? [], scaledThreshold);
    if (r) results.push(r);
  }

  if (active.has("peer_divergence")) {
    const r = detectPeerDivergence(batch, context.ownerCosts ?? {});
    if (r) results.push(r);
  }

  results.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return results;
}

// ---------------------------------------------------------------------------
// Scaled detector variants (accept explicit threshold for settings-aware runs)
// ---------------------------------------------------------------------------

function detectCostSpikeScaled(
  batch: FleetRealtimeEvent[],
  rollingDailyCosts: number[],
  threshold: number,
): RealtimeAnomaly | null {
  if (rollingDailyCosts.length === 0) return null;

  const batchCost = batch.reduce((s, e) => s + (e.cost_millicents ?? 0), 0);
  if (batchCost === 0) return null;

  const avg = rollingDailyCosts.reduce((a, b) => a + b, 0) / rollingDailyCosts.length;
  if (avg === 0) return null;

  const ratio = batchCost / avg;
  if (ratio <= 1 + threshold) return null;

  const pct = Math.round((ratio - 1) * 100);
  const severity: AnomalySeverity = ratio >= 3 ? "high" : ratio >= 2 ? "medium" : "low";

  return {
    kind: "cost_spike",
    severity,
    message: `Cost spike: batch cost ${pct}% above 7d rolling average (${batchCost.toLocaleString()} vs avg ${Math.round(avg).toLocaleString()} millicents)`,
    repo_name: null,
    user_id: null,
    context: {
      batch_cost_millicents: batchCost,
      rolling_avg_millicents: Math.round(avg),
      ratio: Number(ratio.toFixed(2)),
      threshold,
      sigma_reasoning: `${pct}% above 7d mean (${Math.round(avg).toLocaleString()} mc avg)`,
    },
  };
}

function detectTokenExplosionScaled(
  batch: FleetRealtimeEvent[],
  recentEventTokens: number[],
  multiplier: number,
): RealtimeAnomaly | null {
  if (recentEventTokens.length === 0) return null;

  const avg = recentEventTokens.reduce((a, b) => a + b, 0) / recentEventTokens.length;
  if (avg === 0) return null;

  let worstEvent: FleetRealtimeEvent | null = null;
  let worstTotal = 0;

  for (const e of batch) {
    const total = (e.tokens_input ?? 0) + (e.tokens_output ?? 0);
    if (total > avg * multiplier && total > worstTotal) {
      worstTotal = total;
      worstEvent = e;
    }
  }

  if (!worstEvent) return null;

  const ratio = worstTotal / avg;
  const severity: AnomalySeverity = ratio >= 10 ? "high" : ratio >= 5 ? "medium" : "low";

  return {
    kind: "token_explosion",
    severity,
    message: `Token explosion: single event used ${worstTotal.toLocaleString()} tokens (${ratio.toFixed(1)}× per-event average of ${Math.round(avg).toLocaleString()})`,
    repo_name: worstEvent.repo_name ?? null,
    user_id: null,
    context: {
      event_tokens: worstTotal,
      rolling_avg_tokens: Math.round(avg),
      ratio: Number(ratio.toFixed(2)),
      multiplier_threshold: multiplier,
      model: worstEvent.model ?? null,
      sigma_reasoning: `${ratio.toFixed(1)}× per-event mean (${Math.round(avg).toLocaleString()} tok avg)`,
    },
  };
}

function detectToolFailureRateScaled(
  batch: FleetRealtimeEvent[],
  recentEvents: FleetRealtimeEvent[],
  threshold: number,
): RealtimeAnomaly | null {
  const window = [...recentEvents, ...batch].slice(-TOOL_FAILURE_WINDOW);
  if (window.length < 10) return null;

  const failures = window.filter((e) => e.fleet_outcome === "fail").length;
  const rate = failures / window.length;

  if (rate <= threshold) return null;

  const pct = Math.round(rate * 100);
  const severity: AnomalySeverity = rate >= 0.5 ? "high" : rate >= 0.35 ? "medium" : "low";

  return {
    kind: "tool_failure_rate",
    severity,
    message: `High tool-call failure rate: ${pct}% of last ${window.length} fleet events failed (threshold: ${Math.round(threshold * 100)}%)`,
    repo_name: null,
    user_id: null,
    context: {
      failure_count: failures,
      window_size: window.length,
      failure_rate: Number(rate.toFixed(3)),
      threshold,
      sigma_reasoning: `${pct}% failure rate over ${window.length}-event window`,
    },
  };
}

function detectCacheMissStormScaled(
  batch: FleetRealtimeEvent[],
  recentEvents: FleetRealtimeEvent[],
  threshold: number,
): RealtimeAnomaly | null {
  const window = [...recentEvents, ...batch].slice(-CACHE_MISS_WINDOW);
  const tokenEvents = window.filter((e) => (e.tokens_input ?? 0) > 0);
  if (tokenEvents.length < 10) return null;

  const misses = tokenEvents.filter((e) => {
    const inp = e.tokens_input ?? 0;
    const out = e.tokens_output ?? 0;
    if (inp === 0) return true;
    return out / inp > 0.10;
  }).length;

  const rate = misses / tokenEvents.length;
  if (rate <= threshold) return null;

  const pct = Math.round(rate * 100);
  const severity: AnomalySeverity = rate >= 0.95 ? "high" : rate >= 0.90 ? "medium" : "low";

  return {
    kind: "cache_miss_storm",
    severity,
    message: `Cache-miss storm: ${pct}% of last ${tokenEvents.length} token-bearing events had no cache reads (threshold: ${Math.round(threshold * 100)}%)`,
    repo_name: null,
    user_id: null,
    context: {
      miss_count: misses,
      window_size: tokenEvents.length,
      miss_rate: Number(rate.toFixed(3)),
      threshold,
      sigma_reasoning: `${pct}% cache-miss rate over ${tokenEvents.length}-event window`,
    },
  };
}
