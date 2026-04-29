/**
 * forecast.ts — simple linear projection of a daily metric.
 *
 * Used by the dashboard to surface "at this rate, you'll hit X tokens
 * by Friday" / "at this pace, you'll spend $250 this month."
 *
 * The math is intentionally minimal — least-squares slope through the
 * last N daily samples, then project forward to the end of the month
 * or to a target value. We're not pretending to forecast quarter-end
 * numbers; the goal is "where is this trajectory heading next week."
 */

export interface ForecastResult {
  /** Slope per day. */
  perDay: number;
  /** Intercept (the regression's y at index 0). */
  intercept: number;
  /** Sum of values from "now" through the end of the current month. */
  remainingMonth: number;
  /** Projected total for the month (sum so far + remaining). */
  projectedMonthTotal: number;
  /** ISO date when the cumulative crosses `target`, or null if it
   *  doesn't within the next 60 days. */
  hitsTargetOn: string | null;
}

/**
 * Fit a least-squares line to `daily` (oldest-first), project from
 * "today" to month-end and to `target` if provided.
 */
export function forecast(
  daily: number[],
  target: number | null = null,
  asOf: Date = new Date(),
): ForecastResult {
  if (daily.length < 2) {
    return {
      perDay: daily[0] ?? 0,
      intercept: daily[0] ?? 0,
      remainingMonth: (daily[0] ?? 0) * daysLeftInMonth(asOf),
      projectedMonthTotal: (daily[0] ?? 0) * daysInMonth(asOf),
      hitsTargetOn: null,
    };
  }

  const n = daily.length;
  const xMean = (n - 1) / 2;
  const yMean = daily.reduce((s, v) => s + v, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (daily[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  // Project the next K days; the floor protects against negative
  // forecasts being charted as negative tokens (which is meaningless).
  const project = (k: number) => Math.max(0, slope * (n + k) + intercept);

  const daysLeft = daysLeftInMonth(asOf);
  let remainingMonth = 0;
  for (let k = 0; k < daysLeft; k++) {
    remainingMonth += project(k);
  }

  // "Today's MTD" — sum of daily values since the 1st. We don't have
  // calendar awareness for `daily` (it's whatever the caller passed),
  // so the caller is responsible for passing values aligned with the
  // current month. The dashboard does this — we always feed daily as
  // "the current month so far + 0-padded for missing days."
  const monthSoFar = daily.reduce((s, v) => s + v, 0);
  const projectedMonthTotal = monthSoFar + remainingMonth;

  // When does cumulative cross `target`?
  let hitsTargetOn: string | null = null;
  if (target != null && target > 0) {
    let cumulative = monthSoFar;
    for (let k = 0; k < 60; k++) {
      cumulative += project(k);
      if (cumulative >= target) {
        const d = new Date(asOf.getTime() + k * 24 * 3600_000);
        hitsTargetOn = d.toISOString().slice(0, 10);
        break;
      }
    }
  }

  // perDay is the *projected* next-day rate (one step past the last
  // observation), not the fitted value at the last historic point.
  // That's the figure the dashboard needs for "you're trending toward X."
  return {
    perDay: Math.max(0, slope * n + intercept),
    intercept,
    remainingMonth,
    projectedMonthTotal,
    hitsTargetOn,
  };
}

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function daysLeftInMonth(d: Date): number {
  return daysInMonth(d) - d.getUTCDate();
}

/** Format a forecast as a one-liner for chart annotations. */
export function describeForecast(
  metric: string,
  noun: string,
  result: ForecastResult,
  fmt: (n: number) => string,
): string {
  const total = result.projectedMonthTotal;
  return `at this rate · ~${fmt(total)} ${noun} by month end`;
}
