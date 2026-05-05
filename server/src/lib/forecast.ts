/**
 * forecast.ts — pure-stats cost projection for the dashboard.
 *
 * Inputs: a daily history of cost in millicents. Output: 30 days of
 * projected cost with a coarse confidence band. No LLM call — this
 * runs on every dashboard render and must be cheap.
 *
 * Algorithm: Holt-Winters triple exponential smoothing with weekly
 * seasonality (period = 7). Picked because:
 *
 *   - History is daily counts that exhibit strong week-of-day rhythm
 *     (cmux work blasts on weekdays, near-zero on weekends).
 *   - We want a level + trend + season decomposition to give a
 *     plausible projection even off short histories (14 days minimum).
 *   - It produces a single point forecast plus a residual-based band
 *     without requiring scipy or a backend query.
 *
 * For very short histories (<14 days) we degrade to a flat-mean
 * projection — the seasonal decomposition isn't meaningful with one
 * partial week.
 */
export interface ForecastPoint {
  /** Days into the future (1..N). */
  d: number;
  /** Median projection in millicents (>= 0). */
  p50: number;
  /** Lower band (~p10) in millicents. */
  p10: number;
  /** Upper band (~p90) in millicents. */
  p90: number;
}

export interface ForecastInputs {
  /** Daily cost in millicents, oldest → newest. */
  history: number[];
  /** How many days into the future to project. Default 30. */
  horizon?: number;
}

const WEEK = 7;

export function forecast({ history, horizon = 30 }: ForecastInputs): ForecastPoint[] {
  if (history.length === 0) return [];

  // Short history: flat-mean projection. Bands ±50% of mean as a coarse
  // "we don't really know" hint — the dashboard renders a fader region.
  if (history.length < 2 * WEEK) {
    const mean = avg(history);
    const half = Math.max(mean * 0.5, 1);
    const out: ForecastPoint[] = [];
    for (let d = 1; d <= horizon; d++) {
      out.push({
        d,
        p50: Math.max(0, Math.round(mean)),
        p10: Math.max(0, Math.round(mean - half)),
        p90: Math.max(0, Math.round(mean + half)),
      });
    }
    return out;
  }

  // Holt-Winters with additive seasonality. The standard alpha/beta/
  // gamma defaults are reasonable for short histories. We don't need
  // out-of-sample optimization here — the dashboard re-runs daily.
  const alpha = 0.4;  // level smoothing
  const beta  = 0.1;  // trend smoothing
  const gamma = 0.3;  // season smoothing

  // Initialize seasonal indices as the average ratio of each weekday's
  // first cycle to the cycle mean. For additive form we use deltas.
  const firstCycle = history.slice(0, WEEK);
  const firstMean = avg(firstCycle);
  const season = firstCycle.map((v) => v - firstMean);

  let level = firstMean;
  let trend = (avg(history.slice(WEEK, 2 * WEEK)) - firstMean) / WEEK;

  // Track residuals so we can size the confidence band from observed
  // forecast error rather than a fudge factor.
  const residuals: number[] = [];

  for (let i = WEEK; i < history.length; i++) {
    const s = season[i % WEEK];
    const expected = level + trend + s;
    residuals.push(history[i] - expected);

    const newLevel  = alpha * (history[i] - s) + (1 - alpha) * (level + trend);
    const newTrend  = beta  * (newLevel - level) + (1 - beta) * trend;
    const newSeason = gamma * (history[i] - newLevel) + (1 - gamma) * s;

    level = newLevel;
    trend = newTrend;
    season[i % WEEK] = newSeason;
  }

  const sigma = stdev(residuals);

  // Project. Bands widen with sqrt(d) to reflect compounding uncertainty
  // (random walk approximation; not exact for HW but visually right).
  const out: ForecastPoint[] = [];
  for (let d = 1; d <= horizon; d++) {
    const s = season[(history.length + d - 1) % WEEK];
    const point = level + d * trend + s;
    const band = sigma * Math.sqrt(d);
    out.push({
      d,
      p50: Math.max(0, Math.round(point)),
      p10: Math.max(0, Math.round(point - 1.28 * band)),  // ~10th percentile
      p90: Math.max(0, Math.round(point + 1.28 * band)),  // ~90th percentile
    });
  }
  return out;
}

/**
 * Sum the projection. Useful for "end-of-month estimate" copy and for
 * comparing against plan caps.
 */
export function sumForecast(points: ForecastPoint[]): { p50: number; p10: number; p90: number } {
  let p50 = 0, p10 = 0, p90 = 0;
  for (const p of points) {
    p50 += p.p50;
    p10 += p.p10;
    p90 += p.p90;
  }
  return { p50, p10, p90 };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}
