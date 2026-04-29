/**
 * anomalies.ts — purely numeric anomaly detection.
 *
 * The dashboard renders these as small inline badges next to stat cards
 * ("↑ 3.2× weekly avg") so users see what's surprising without reading
 * the briefing. No LLM needed — they're cheap delta + z-score checks.
 */

export interface Anomaly {
  /** What the anomaly is about: "tokens", "cost", "events", "repo:X". */
  metric: string;
  /** Value relative to baseline: 1.0 = baseline, 2.0 = 2× baseline, -0.5 = half. */
  delta: number;
  /** Severity hint, mirrors stat-card accents. */
  severity: "low" | "medium" | "high";
  /** One-liner summary for inline display. */
  message: string;
}

interface DetectInput {
  current: number;
  /** Baseline values from the comparable prior periods. */
  baseline: number[];
  metric: string;
  /** Friendly noun: "tokens", "events", etc. */
  noun: string;
}

/** Compute mean + stdev. Returns 0/1 if baseline is empty. */
function stats(arr: number[]): { mean: number; stdev: number } {
  if (!arr.length) return { mean: 0, stdev: 1 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, stdev: Math.sqrt(variance) || 1 };
}

export function detectAnomaly({ current, baseline, metric, noun }: DetectInput): Anomaly | null {
  const { mean, stdev } = stats(baseline);
  if (mean === 0) return null;
  const delta = current / mean - 1;
  const z = (current - mean) / stdev;

  // Below 1σ: not interesting.
  if (Math.abs(z) < 1) return null;

  const severity: Anomaly["severity"] =
    Math.abs(z) >= 3 ? "high" : Math.abs(z) >= 2 ? "medium" : "low";

  const direction = current > mean ? "up" : "down";
  const factor = current > mean
    ? `${(current / mean).toFixed(1)}×`
    : `${(mean / current).toFixed(1)}× lower`;

  const message = current > mean
    ? `${noun} ${direction} ${factor} vs weekly baseline`
    : `${noun} ${factor} than weekly baseline`;

  return { metric, delta, severity, message };
}
