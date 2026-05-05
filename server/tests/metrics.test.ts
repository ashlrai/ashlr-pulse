/**
 * metrics.test.ts — counters + tick ring + healthz snapshot shape.
 *
 * Pulse self-observability is exposed via /api/healthz under the
 * `metrics` key. We pin the snapshot shape here so that consumers
 * (oncall dashboards, downstream monitors) don't break silently when
 * the internal layout changes.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  incrCounter,
  getCounters,
  recordTickResult,
  recentTicks,
  metricsSnapshot,
  resetCountersForTest,
} from "../src/lib/metrics";

describe("counters", () => {
  beforeEach(() => resetCountersForTest());

  test("increments by 1 by default", () => {
    incrCounter("foo");
    incrCounter("foo");
    expect(getCounters()).toEqual({ foo: 2 });
  });

  test("increments by explicit value", () => {
    incrCounter("spans.inserted", 50);
    incrCounter("spans.inserted", 25);
    expect(getCounters()).toEqual({ "spans.inserted": 75 });
  });

  test("multiple counters are independent", () => {
    incrCounter("a");
    incrCounter("b", 5);
    expect(getCounters()).toEqual({ a: 1, b: 5 });
  });
});

describe("tick ring", () => {
  beforeEach(() => resetCountersForTest());

  test("records and returns a tick", () => {
    recordTickResult({ endpoint: "digest", status: 200, duration_ms: 42 });
    const ticks = recentTicks();
    expect(ticks).toHaveLength(1);
    expect(ticks[0].endpoint).toBe("digest");
    expect(ticks[0].status).toBe(200);
    expect(ticks[0].duration_ms).toBe(42);
    expect(ticks[0].ts).toMatch(/T\d{2}:\d{2}/);
  });

  test("ring is bounded — old entries roll off after 32", () => {
    for (let i = 0; i < 40; i++) {
      recordTickResult({ endpoint: "digest", status: 200, duration_ms: i });
    }
    const ticks = recentTicks();
    expect(ticks).toHaveLength(32);
    // Oldest preserved entry should be the 8th insert (40 - 32).
    expect(ticks[0].duration_ms).toBe(8);
    expect(ticks[31].duration_ms).toBe(39);
  });

  test("status: null entries indicate network failure", () => {
    recordTickResult({
      endpoint: "github-sync",
      status: null,
      duration_ms: 100,
      error: "ECONNREFUSED",
    });
    const ticks = recentTicks();
    expect(ticks[0].status).toBeNull();
    expect(ticks[0].error).toBe("ECONNREFUSED");
  });
});

describe("metricsSnapshot for /api/healthz", () => {
  beforeEach(() => resetCountersForTest());

  test("includes counters and per-endpoint cron summary", () => {
    incrCounter("otlp.ingest.ok", 3);
    recordTickResult({ endpoint: "digest", status: 200, duration_ms: 50 });
    recordTickResult({ endpoint: "github-sync", status: 500, duration_ms: 800 });

    const snap = metricsSnapshot();
    expect(snap.counters).toEqual({ "otlp.ingest.ok": 3 });
    expect(snap.cron.digest.last_status).toBe(200);
    expect(snap.cron.digest.recent_failures).toBe(0);
    expect(snap.cron["github-sync"].last_status).toBe(500);
    expect(snap.cron["github-sync"].recent_failures).toBe(1);
  });

  test("counts failures across multiple non-2xx ticks for one endpoint", () => {
    recordTickResult({ endpoint: "digest", status: 500, duration_ms: 1 });
    recordTickResult({ endpoint: "digest", status: 500, duration_ms: 2 });
    recordTickResult({ endpoint: "digest", status: 200, duration_ms: 3 });
    const snap = metricsSnapshot();
    expect(snap.cron.digest.recent_failures).toBe(2);
    expect(snap.cron.digest.last_status).toBe(200);
  });

  test("empty state — no counters, no ticks", () => {
    const snap = metricsSnapshot();
    expect(snap.counters).toEqual({});
    expect(snap.cron).toEqual({});
  });
});
