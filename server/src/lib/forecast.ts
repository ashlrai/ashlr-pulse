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

// ─────────────────────────────────────────────────────────────────────────────
// OLS linear-regression helpers
// Used by /compare and /forecast for trend overlays and scenario sliders.
// These are PURE functions — no DB, no LLM, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

export interface SeriesPoint {
  /** YYYY-MM-DD date string. */
  ts: string;
  value: number;
}

export interface OlsForecastPoint {
  /** YYYY-MM-DD date string (may be in the future). */
  ts: string;
  value: number;
  lower: number;
  upper: number;
}

export interface RegressionResult {
  slope: number;
  intercept: number;
  rSquared: number;
  /**
   * 90% confidence interval half-width per future point.
   *
   * For OLS with df = n − 2 this is t_{0.95, n−2} × se_forecast where
   * se_forecast = s × sqrt(1 + 1/n + (x* − x̄)² / Sxx).
   * Here we pre-compute the constant component (at x* = last observed
   * point, i.e. daysAhead = 0) and let projectForecast add the
   * (x* − x̄)² term per step. The field exposed here is the residual
   * standard error s, so callers can reconstruct any CI.
   */
  confidenceHalfWidth: number;
}

/**
 * Simple OLS linear regression over a date series.
 *
 * x is encoded as integer day index (0..n-1) so the slope is in
 * value-per-day and is calendar-aware when ts strings are sorted.
 * Returns null when n < 2 (can't fit a line through fewer than 2 points).
 */
export function linearRegression(history: SeriesPoint[]): RegressionResult | null {
  const n = history.length;
  if (n < 2) return null;

  // x = [0, 1, 2, …, n-1]; y = history values
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += history[i].value;
    sumXY += i * history[i].value;
    sumX2 += i * i;
  }
  const xBar = sumX / n;
  const yBar = sumY / n;
  const Sxx = sumX2 - n * xBar * xBar;

  // Degenerate case: all x identical (n=1 already rejected above;
  // Sxx=0 only when all x are equal which can't happen for n≥2 with
  // distinct integer indices — but guard anyway).
  if (Sxx === 0) {
    return { slope: 0, intercept: yBar, rSquared: 0, confidenceHalfWidth: 0 };
  }

  const slope     = (sumXY - n * xBar * yBar) / Sxx;
  const intercept = yBar - slope * xBar;

  // R²: 1 − SSres/SStot. For zero-variance y, define R²=1 (perfect fit
  // of the constant line — consistent with "slope≈0" semantics).
  let SStot = 0, SSres = 0;
  for (let i = 0; i < n; i++) {
    const yHat = slope * i + intercept;
    SStot += (history[i].value - yBar) ** 2;
    SSres += (history[i].value - yHat) ** 2;
  }
  const rSquared = SStot === 0 ? 1 : Math.max(0, 1 - SSres / SStot);

  // Residual standard error s (df = n − 2).
  const s = n > 2 ? Math.sqrt(SSres / (n - 2)) : Math.sqrt(SSres);

  // 90% CI half-width at x* = n-1 (last observation, daysAhead=0).
  // t_{0.95, df} approximation: for df≥30 ≈ 1.645; for df<30 we use
  // a conservative 2.0 (errs on the wide side for short histories).
  const df = Math.max(1, n - 2);
  const t90 = df >= 30 ? 1.645 : 2.0;
  // se = s * sqrt(1 + 1/n + (x*-xBar)²/Sxx); at x*=n-1:
  const xStar = n - 1;
  const se = s * Math.sqrt(1 + 1 / n + (xStar - xBar) ** 2 / Sxx);
  // Visualization floor: a perfectly-fit line has SSres=0 → CI=0, which
  // would render an invisible band on the dashboard. Future projections
  // carry intrinsic uncertainty even when past fits exactly, so we floor
  // the band at 0.1% of |yBar| (or 1e-9 for zero-mean series).
  const visualizationFloor = Math.max(Math.abs(yBar) * 1e-3, 1e-9);
  const confidenceHalfWidth = Math.max(t90 * se, visualizationFloor);

  return { slope, intercept, rSquared, confidenceHalfWidth };
}

/**
 * Project N days forward from the last history date using the OLS line,
 * returning a 90% CI band at each step.
 *
 * The CI widens as (x* − x̄)² grows — farther extrapolations are
 * legitimately less certain. Returns [] when history has fewer than 2 points.
 */
export function projectForecast(
  history: SeriesPoint[],
  daysAhead: number,
): OlsForecastPoint[] {
  const reg = linearRegression(history);
  if (!reg || history.length < 2) return [];

  const n = history.length;
  const xBar = (n - 1) / 2; // mean of [0..n-1]
  let Sxx = 0;
  for (let i = 0; i < n; i++) Sxx += (i - xBar) ** 2;

  // Residual standard error — reconstruct from confidenceHalfWidth.
  // We need s separately for per-step se computation.
  let SSres = 0;
  for (let i = 0; i < n; i++) {
    SSres += (history[i].value - (reg.slope * i + reg.intercept)) ** 2;
  }
  const s = n > 2 ? Math.sqrt(SSres / (n - 2)) : Math.sqrt(SSres);
  const df = Math.max(1, n - 2);
  const t90 = df >= 30 ? 1.645 : 2.0;

  // Parse last date to generate future ts strings.
  const lastTs = history[history.length - 1].ts;
  const lastDate = new Date(`${lastTs}T00:00:00Z`);

  // Same visualization floor as linearRegression — keeps the band visible
  // for perfect-fit synthetic data and for tests that don't simulate noise.
  // Computed once: yBar over [0..n-1] indices isn't relevant; floor is
  // computed against the value scale via the regression's intercept+slope.
  const yBarVal = reg.intercept + reg.slope * ((n - 1) / 2);
  const visualizationFloor = Math.max(Math.abs(yBarVal) * 1e-3, 1e-9);

  const out: OlsForecastPoint[] = [];
  for (let d = 1; d <= daysAhead; d++) {
    const xStar = n - 1 + d; // one-indexed future step
    const value = reg.slope * xStar + reg.intercept;
    const se = s * Math.sqrt(1 + 1 / n + (xStar - xBar) ** 2 / Sxx);
    const half = Math.max(t90 * se, visualizationFloor);

    const futureDate = new Date(lastDate.getTime() + d * 86_400_000);
    const ts = futureDate.toISOString().slice(0, 10);

    out.push({
      ts,
      value:  Math.max(0, value),
      lower:  Math.max(0, value - half),
      upper:  Math.max(0, value + half),
    });
  }
  return out;
}

export interface AnomalyMarker {
  ts: string;
  value: number;
  severity: "warn" | "crit";
}

/**
 * Detect anomalies in a daily series using a rolling z-score.
 *
 * For each point we compute the mean and stddev of the preceding
 * `windowDays` values (exclusive of the current point). A point is
 * anomalous when |value − μ| > threshold × σ.
 *
 *   warn: |z| > 2
 *   crit: |z| > 3
 *
 * Points in the first window are skipped (insufficient history).
 * Returns only the anomalous points (empty array = clean series).
 */
export function detectAnomalies(
  series: SeriesPoint[],
  windowDays = 14,
): AnomalyMarker[] {
  const markers: AnomalyMarker[] = [];
  for (let i = windowDays; i < series.length; i++) {
    const window = series.slice(i - windowDays, i).map((p) => p.value);
    const mu = avg(window);
    const sigma = stdev(window);
    if (sigma === 0) {
      // Constant window: σ-based z-score is undefined. But a value
      // different from the constant μ is itself the anomaly — flag as
      // crit. (When value === μ the window is still flat and there's
      // nothing to mark.)
      if (series[i].value !== mu) {
        markers.push({ ts: series[i].ts, value: series[i].value, severity: "crit" });
      }
      continue;
    }

    const z = Math.abs(series[i].value - mu) / sigma;
    if (z > 3) {
      markers.push({ ts: series[i].ts, value: series[i].value, severity: "crit" });
    } else if (z > 2) {
      markers.push({ ts: series[i].ts, value: series[i].value, severity: "warn" });
    }
  }
  return markers;
}
