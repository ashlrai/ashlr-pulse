/**
 * cost-drift-detector.ts — cross-source cost attribution + model preference
 * drift detector.
 *
 * Pure function: no DB, no LLM, no side effects. Takes two 14-day windows
 * of daily aggregates (prev14d, curr14d) and computes:
 *
 *   1. sourceShift — WoW % delta per source (cursor, claude_code, copilot…)
 *   2. modelShift  — WoW % delta per model (opus, sonnet, haiku…)
 *   3. predictedDrift7d — OLS-extrapolated 7-day forecast per source + model
 *   4. recommendation  — human-readable summary of the top anomaly
 *
 * Threshold: shifts > DRIFT_THRESHOLD_PCT (5%) are flagged as anomalous.
 *
 * Algorithm for OLS trend: we reuse the linearRegression + projectForecast
 * helpers from forecast.ts, encoding each source/model daily cost as a
 * SeriesPoint time-series.
 *
 * Privacy floor: only aggregates + enums (source/model names). No prompts,
 * completions, code, or PII.
 */

import { linearRegression, type SeriesPoint } from "./forecast";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One row per (date, source, model) — mirrors peer_share_daily_aggregate.
 * cost_millicents is the raw cost; callers must not pass user-content fields.
 */
export interface DailyAggregate {
  /** YYYY-MM-DD */
  date: string;
  /** Source enum: "claude_code" | "cursor" | "copilot" | "codex" | etc. */
  source: string;
  /** Model name e.g. "claude-opus-4-7", "claude-sonnet-4-6", "gpt-4o". */
  model: string;
  /** Raw cost in millicents (1 cent = 1000 millicents). */
  cost_millicents: number;
  /** Event count for this bucket. */
  event_count: number;
}

/** % shift per key. Positive = increase, negative = decrease. */
export type ShiftMap = Record<string, number>;

/** 7-day OLS projection per key (millicents/day). */
export interface DriftForecast {
  /** Projected cost in millicents for day+1 through day+7. */
  byDay: number[];
  /** OLS slope (millicents/day). Positive = growing spend. */
  slope: number;
  /** R² goodness of fit. Low R² means noisy / unreliable forecast. */
  rSquared: number;
}

export interface CostDrift {
  /**
   * WoW % shift per source. Key is source enum string.
   * e.g. { cursor: 12.4, claude_code: -8.1 }
   */
  sourceShift: ShiftMap;
  /**
   * WoW % shift per model (normalized to short name).
   * e.g. { opus: -2.1, sonnet: 5.3 }
   */
  modelShift: ShiftMap;
  /**
   * OLS 7-day daily cost forecast per source.
   * Only included for sources with enough history (≥4 data points).
   */
  predictedDrift7d: Record<string, DriftForecast>;
  /**
   * Top-priority recommendation string. Empty string when no anomaly.
   */
  recommendation: string;
  /**
   * Sources with |shift| > DRIFT_THRESHOLD_PCT, sorted by absolute magnitude desc.
   */
  anomalousShifts: Array<{ key: string; kind: "source" | "model"; pct: number }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum % shift to flag as anomalous. */
export const DRIFT_THRESHOLD_PCT = 5;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Normalize a model identifier to a short canonical form for display.
 * "claude-opus-4-7" → "opus", "claude-sonnet-4-6" → "sonnet", etc.
 * Unknown model IDs pass through as-is.
 */
export function normalizeModelKey(model: string): string {
  const lc = model.toLowerCase();
  if (lc.includes("opus"))   return "opus";
  if (lc.includes("sonnet")) return "sonnet";
  if (lc.includes("haiku"))  return "haiku";
  if (lc.includes("gpt-4o")) return "gpt-4o";
  if (lc.includes("gpt-4"))  return "gpt-4";
  if (lc.includes("gpt-3"))  return "gpt-3.5";
  if (lc.includes("gemini")) return "gemini";
  if (lc.includes("mistral"))return "mistral";
  if (lc.includes("deepseek")) return "deepseek";
  // Fallback: trim to first 16 chars so the key stays readable.
  return model.slice(0, 16);
}

/** Sum cost_millicents across a DailyAggregate slice. */
function sumCost(rows: DailyAggregate[]): number {
  return rows.reduce((a, r) => a + (r.cost_millicents ?? 0), 0);
}

/** Group rows by a key function and return a Record<key, total cost>. */
function costByKey(
  rows: DailyAggregate[],
  keyFn: (r: DailyAggregate) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] = (out[k] ?? 0) + (r.cost_millicents ?? 0);
  }
  return out;
}

/**
 * Compute WoW % shift between two cost maps.
 * Δ% = (curr − prev) / prev × 100.
 * New keys (prev = 0) report +Infinity-clamped to +100%.
 * Dropped keys (curr = 0) report -100%.
 */
function computeShift(
  prev: Record<string, number>,
  curr: Record<string, number>,
): ShiftMap {
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const out: ShiftMap = {};
  for (const k of allKeys) {
    const p = prev[k] ?? 0;
    const c = curr[k] ?? 0;
    if (p === 0 && c === 0) continue; // no cost in either period — skip
    if (p === 0) {
      out[k] = 100; // new source / model appeared
    } else {
      out[k] = Number(((c - p) / p * 100).toFixed(2));
    }
  }
  return out;
}

/**
 * Build a SeriesPoint[] from daily aggregate rows for a single source/model key.
 * Days with no rows get value=0 so the OLS line sees a complete 14-day history.
 */
function buildDailySeries(rows: DailyAggregate[], dates: string[]): SeriesPoint[] {
  const byDate: Record<string, number> = {};
  for (const r of rows) {
    byDate[r.date] = (byDate[r.date] ?? 0) + (r.cost_millicents ?? 0);
  }
  return dates.map((ts) => ({ ts, value: byDate[ts] ?? 0 }));
}

/**
 * Collect the sorted list of unique dates from a window of aggregates.
 */
function sortedDates(rows: DailyAggregate[]): string[] {
  return [...new Set(rows.map((r) => r.date))].sort();
}

// ─── Main detector ────────────────────────────────────────────────────────────

/**
 * Detect cost drift between two consecutive 14-day windows.
 *
 * @param prev14d  Older window (days −28 to −15 relative to today).
 * @param curr14d  Newer window (days −14 to −1 relative to today).
 */
export function detectCostDrift(
  prev14d: DailyAggregate[],
  curr14d: DailyAggregate[],
): CostDrift {
  // ── 1. WoW source shift ──────────────────────────────────────────────
  const prevBySrc = costByKey(prev14d, (r) => r.source);
  const currBySrc = costByKey(curr14d, (r) => r.source);
  const sourceShift = computeShift(prevBySrc, currBySrc);

  // ── 2. WoW model shift (normalized) ─────────────────────────────────
  const prevByModel = costByKey(prev14d, (r) => normalizeModelKey(r.model));
  const currByModel = costByKey(curr14d, (r) => normalizeModelKey(r.model));
  const modelShift = computeShift(prevByModel, currByModel);

  // ── 3. OLS 7d forecast per source ────────────────────────────────────
  // Combine both windows into a 28-day series for the trend line; project
  // 7 days forward. We need at least 4 data points per source to fit OLS.
  const allRows = [...prev14d, ...curr14d];
  const allDates = sortedDates(allRows);
  const allSources = [...new Set(allRows.map((r) => r.source))];

  const predictedDrift7d: Record<string, DriftForecast> = {};

  for (const src of allSources) {
    const srcRows = allRows.filter((r) => r.source === src);
    const series = buildDailySeries(srcRows, allDates);
    const nonZero = series.filter((p) => p.value > 0).length;
    if (nonZero < 4) continue; // not enough signal

    const reg = linearRegression(series);
    if (!reg) continue;

    const n = series.length;
    // Project 7 days forward using the OLS line.
    const byDay: number[] = [];
    for (let d = 1; d <= 7; d++) {
      const xStar = n - 1 + d;
      byDay.push(Math.max(0, Math.round(reg.slope * xStar + reg.intercept)));
    }

    predictedDrift7d[src] = {
      byDay,
      slope: Number(reg.slope.toFixed(4)),
      rSquared: Number(reg.rSquared.toFixed(4)),
    };
  }

  // ── 4. Anomalous shifts ───────────────────────────────────────────────
  const anomalousShifts: CostDrift["anomalousShifts"] = [];

  for (const [k, pct] of Object.entries(sourceShift)) {
    if (Math.abs(pct) >= DRIFT_THRESHOLD_PCT) {
      anomalousShifts.push({ key: k, kind: "source", pct });
    }
  }
  for (const [k, pct] of Object.entries(modelShift)) {
    if (Math.abs(pct) >= DRIFT_THRESHOLD_PCT) {
      anomalousShifts.push({ key: k, kind: "model", pct });
    }
  }
  // Sort by absolute magnitude descending.
  anomalousShifts.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  // ── 5. Recommendation ────────────────────────────────────────────────
  const recommendation = buildRecommendation(
    sourceShift,
    modelShift,
    anomalousShifts,
    predictedDrift7d,
    currBySrc,
    allRows,
  );

  return { sourceShift, modelShift, predictedDrift7d, recommendation, anomalousShifts };
}

// ─── Recommendation builder ────────────────────────────────────────────────

function buildRecommendation(
  sourceShift: ShiftMap,
  modelShift: ShiftMap,
  anomalous: CostDrift["anomalousShifts"],
  predicted: Record<string, DriftForecast>,
  currBySrc: Record<string, number>,
  allRows: DailyAggregate[],
): string {
  if (anomalous.length === 0) return "";

  const top = anomalous[0];

  // ── Source drift ───────────────────────────────────────────────────────
  if (top.kind === "source") {
    const dir = top.pct > 0 ? "up" : "down";
    const sign = top.pct > 0 ? "+" : "";
    const pctStr = `${sign}${top.pct.toFixed(1)}%`;

    // Look for a corresponding drop in another source — signals consolidation opp.
    const opposite = Object.entries(sourceShift)
      .filter(([k, v]) => k !== top.key && (top.pct > 0 ? v < -DRIFT_THRESHOLD_PCT : v > DRIFT_THRESHOLD_PCT))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];

    if (opposite && top.pct > 0) {
      return `${friendlySource(top.key)} adoption ${pctStr} week-over-week while ${friendlySource(opposite[0])} dropped ${opposite[1].toFixed(1)}%; consider consolidating licenses to reduce per-seat overhead.`;
    }

    // Growing source with 7d trend
    const forecast = predicted[top.key];
    if (forecast && forecast.slope > 0 && top.pct > 0) {
      const projTotal = forecast.byDay.reduce((a, b) => a + b, 0);
      const projUsd = (projTotal / 100_000).toFixed(2); // millicents → USD
      return `${friendlySource(top.key)} spend ${dir} ${pctStr} WoW; OLS trend projects an additional ~$${projUsd} over the next 7 days — review seat count or usage caps.`;
    }

    return `${friendlySource(top.key)} spend ${dir} ${pctStr} week-over-week; investigate before next billing cycle.`;
  }

  // ── Model drift ────────────────────────────────────────────────────────
  const modelDir = top.pct > 0 ? "up" : "down";
  const modelSign = top.pct > 0 ? "+" : "";
  const modelPct = `${modelSign}${top.pct.toFixed(1)}%`;

  // Opus growing is an upsell signal / cost warning.
  if (top.key === "opus" && top.pct > 0) {
    // Find if sonnet is dropping — natural model drift signal.
    const sonnetShift = modelShift["sonnet"];
    if (sonnetShift !== undefined && sonnetShift < -DRIFT_THRESHOLD_PCT) {
      return `Model mix shifting toward Opus (${modelPct}) as Sonnet usage falls ${sonnetShift.toFixed(1)}% — Opus is ~5× more expensive; audit whether task complexity warrants the upgrade.`;
    }
    return `Opus usage ${modelDir} ${modelPct} WoW — highest-cost model tier; verify workloads require Opus vs Sonnet to avoid budget creep.`;
  }

  // Sonnet growing (good or neutral).
  if (top.key === "sonnet" && top.pct > 0) {
    const opusShift = modelShift["opus"];
    if (opusShift !== undefined && opusShift < -DRIFT_THRESHOLD_PCT) {
      return `Team shifting from Opus to Sonnet (${modelPct} WoW) — this is a positive efficiency signal; estimated cost reduction aligns with lower per-token rates.`;
    }
    return `Sonnet usage growing ${modelPct} WoW; cost-efficient relative to Opus — no action needed unless volume outpaces budget.`;
  }

  return `Model mix shift: ${top.key} ${modelDir} ${modelPct} week-over-week; review whether this aligns with planned workloads.`;
}

function friendlySource(src: string): string {
  const MAP: Record<string, string> = {
    cursor:       "Cursor",
    claude_code:  "Claude Code",
    copilot:      "Copilot",
    codex:        "Codex",
    wakatime:     "WakaTime",
    shell:        "Shell",
    git:          "Git",
    ashlr_plugin: "ashlr-plugin",
    "ashlr-fleet":"ashlr-fleet",
  };
  return MAP[src] ?? src;
}

// ─── Org-level aggregation helper (used by API route) ─────────────────────

/**
 * Partition a 28-day flat aggregate list into prev14d / curr14d windows.
 * `rows` must be sorted or have a `date` field — we split by calendar date.
 *
 * The caller fetches last 28 days from the DB and passes them here;
 * this is a pure helper so it remains testable without a DB.
 */
export function splitWindows(rows: DailyAggregate[]): {
  prev14d: DailyAggregate[];
  curr14d: DailyAggregate[];
} {
  if (rows.length === 0) return { prev14d: [], curr14d: [] };

  const dates = sortedDates(rows);
  // Find the midpoint: split into two equal halves.
  const mid = Math.floor(dates.length / 2);
  const midDate = dates[mid];

  const prev14d = rows.filter((r) => r.date < midDate);
  const curr14d = rows.filter((r) => r.date >= midDate);
  return { prev14d, curr14d };
}

/** Total cost across a window in millicents. */
export function totalCostMillicents(rows: DailyAggregate[]): number {
  return sumCost(rows);
}
