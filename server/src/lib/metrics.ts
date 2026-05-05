/**
 * metrics.ts — in-process counters + timing for Pulse self-observability.
 *
 * This is intentionally minimal: a Map<string, number> for counters
 * and a small ring of recent tick results so /api/healthz can surface
 * "the cron actually ran in the last hour" without a separate metrics
 * backend. When Pulse moves multi-node it can be swapped for Redis or
 * a real metrics exporter; the API surface here stays.
 *
 * Why not pino metric-event logs alone? Because operators need a
 * scrape target — `curl /api/healthz` should answer "is ingest
 * dropping spans?" without grep'ing log streams.
 */

const counters = new Map<string, number>();

export function incrCounter(name: string, value: number = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

export function getCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetCountersForTest(): void {
  counters.clear();
  tickResults.length = 0;
}

// ---------------------------------------------------------------------------
// Cron tick history — fixed-size ring so /api/healthz can answer
// "did the cron run recently and did it succeed?".
// ---------------------------------------------------------------------------

interface TickResult {
  endpoint: string;
  status: number | null; // null = network/throw before HTTP
  duration_ms: number;
  ts: string;
  error?: string;
}

const TICK_RING_SIZE = 32;
const tickResults: TickResult[] = [];

export function recordTickResult(r: Omit<TickResult, "ts"> & { ts?: string }): void {
  const entry: TickResult = { ...r, ts: r.ts ?? new Date().toISOString() };
  tickResults.push(entry);
  if (tickResults.length > TICK_RING_SIZE) tickResults.shift();
}

export function recentTicks(): TickResult[] {
  return tickResults.slice();
}

/**
 * Snapshot for /api/healthz. Folds ticks into a small per-endpoint
 * summary so the body stays readable.
 */
export function metricsSnapshot(): {
  counters: Record<string, number>;
  cron: Record<string, { last_status: number | null; last_ts: string; last_duration_ms: number; recent_failures: number }>;
} {
  // Ring is insertion-ordered; the final write per endpoint wins as
  // `last_*`, and `recent_failures` accumulates across the window.
  // Don't compare ts strings to decide latest — ticks can share a
  // millisecond and the test for that case used to flap.
  const cron: ReturnType<typeof metricsSnapshot>["cron"] = {};
  for (const r of tickResults) {
    const isFail = !(r.status && r.status >= 200 && r.status < 300);
    const prev = cron[r.endpoint];
    cron[r.endpoint] = {
      last_status: r.status,
      last_ts: r.ts,
      last_duration_ms: r.duration_ms,
      recent_failures: (prev?.recent_failures ?? 0) + (isFail ? 1 : 0),
    };
  }
  return { counters: getCounters(), cron };
}
