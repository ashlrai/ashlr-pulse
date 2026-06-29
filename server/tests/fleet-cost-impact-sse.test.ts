/**
 * fleet-cost-impact-sse.test.ts
 *
 * Tests for:
 *
 *   1. FleetRealtimeEvent — new cost-delta fields (cost_delta_millicents,
 *      cost_vs_baseline, variance_pct) are populated correctly by
 *      redactForBroadcast when a CostImpactFields is provided.
 *
 *   2. Privacy floor — new fields are pure numeric, never contain strings
 *      that could carry user content, and do NOT appear in NEVER_BROADCAST.
 *
 *   3. CostWindowAggregator (white-box via the exported route types) —
 *      5-minute window bucketing and delta/variance arithmetic. The
 *      aggregator logic is exercised by directly simulating the ingest path
 *      using redactForBroadcast + computeCostImpactFields.
 *
 * All tests are pure (no DB, no network).
 */

import { describe, it, expect } from "bun:test";
import {
  redactForBroadcast,
  toFleetEventJSON,
  type FleetRealtimeEvent,
} from "../src/lib/fleet-realtime";
import { computeCostImpactFields } from "../src/lib/fleet-cost-impact";
import { FORBIDDEN_FIELDS } from "../src/lib/peer-share-guard";
import type { ActivityEventInsert } from "../src/lib/otel-genai";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFleetRow(overrides: Partial<ActivityEventInsert> = {}): ActivityEventInsert {
  return {
    ts:                             "2026-06-29T10:00:00.000Z",
    user_id:                        "user-abc",
    session_id:                     "session-xyz",
    source:                         "ashlr-fleet",
    provider:                       "claude",
    model:                          "claude-opus-4-7",
    duration_ms:                    1200,
    tokens_input:                   800,
    tokens_output:                  200,
    tokens_reasoning:               null,
    tokens_cache_read:              null,
    tokens_cache_write:             null,
    tokens_cache_5m_write:          null,
    tokens_cache_1h_write:          null,
    tool_calls_count:               null,
    tool_calls_types:               null,
    accepted_count:                 null,
    rejected_count:                 null,
    project_hash:                   "abc123",
    repo_name:                      "acme/api",
    git_branch:                     "feat/my-branch",
    language:                       "TypeScript",
    tokens_saved:                   null,
    tokens_saved_breakdown:         null,
    plugin_features:                null,
    plugin_version:                 null,
    plugin_genome_hit_rate:         null,
    span_id:                        "deadbeef12345678",
    cost_millicents:                1000,
    pricing_version:                3,
    dedup_key:                      "abc123dedup",
    fleet_event:                    "proposal",
    fleet_outcome:                  "approved",
    fleet_owner:                    "mason",
    codex_plan_type:                null,
    codex_originator:               null,
    codex_parent_thread_id:         null,
    codex_cli_version:              null,
    codex_context_window:           null,
    codex_rate_limit_primary_pct:   null,
    codex_rate_limit_secondary_pct: null,
    codex_sandbox_policy:           null,
    codex_approval_policy:          null,
    codex_effort:                   null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. New cost-delta fields populated by redactForBroadcast
// ---------------------------------------------------------------------------

describe("fleet-realtime — cost_delta_millicents / cost_vs_baseline / variance_pct", () => {
  it("populates cost_delta_millicents as user_cost − team_avg", () => {
    const row    = makeFleetRow({ cost_millicents: 1500 });
    const impact = computeCostImpactFields(1500, 1000);
    const payload = redactForBroadcast(row, impact);

    // delta = 1500 − 1000 = 500
    expect(payload.cost_delta_millicents).toBe(500);
  });

  it("populates cost_vs_baseline as peer_divergence_ratio (1.5 when 1.5× team avg)", () => {
    const row    = makeFleetRow({ cost_millicents: 1500 });
    const impact = computeCostImpactFields(1500, 1000);
    const payload = redactForBroadcast(row, impact);

    expect(payload.cost_vs_baseline).toBeCloseTo(1.5, 2);
  });

  it("populates variance_pct as (delta / team_avg) × 100", () => {
    const row    = makeFleetRow({ cost_millicents: 1500 });
    const impact = computeCostImpactFields(1500, 1000);
    const payload = redactForBroadcast(row, impact);

    // (500 / 1000) × 100 = 50%
    expect(payload.variance_pct).toBeCloseTo(50, 1);
  });

  it("variance_pct is negative when user cost < team_avg", () => {
    const row    = makeFleetRow({ cost_millicents: 400 });
    const impact = computeCostImpactFields(400, 1000);
    const payload = redactForBroadcast(row, impact);

    // delta = −600; (−600 / 1000) × 100 = −60%
    expect(payload.cost_delta_millicents).toBe(-600);
    expect(payload.variance_pct).toBeCloseTo(-60, 1);
  });

  it("variance_pct is 0 when user cost equals team_avg", () => {
    const row    = makeFleetRow({ cost_millicents: 1000 });
    const impact = computeCostImpactFields(1000, 1000);
    const payload = redactForBroadcast(row, impact);

    expect(payload.cost_delta_millicents).toBe(0);
    expect(payload.variance_pct).toBeCloseTo(0, 2);
  });

  it("variance_pct clamps to 9999 when team_avg is 0 and user cost > 0", () => {
    const row    = makeFleetRow({ cost_millicents: 500 });
    const impact = computeCostImpactFields(500, 0);
    const payload = redactForBroadcast(row, impact);

    // team_avg = 0 → clamp positive delta to 9999
    expect(payload.variance_pct).toBe(9999);
  });

  it("cost-delta fields are absent when no costImpact is provided", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow()));

    expect(payload.cost_delta_millicents).toBeUndefined();
    expect(payload.cost_vs_baseline).toBeUndefined();
    expect(payload.variance_pct).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Privacy floor — new fields must be purely numeric
// ---------------------------------------------------------------------------

describe("fleet-realtime — cost-delta fields privacy floor", () => {
  it("cost_delta_millicents is a finite number", () => {
    const impact  = computeCostImpactFields(2000, 1000);
    const payload = redactForBroadcast(makeFleetRow({ cost_millicents: 2000 }), impact);

    expect(typeof payload.cost_delta_millicents).toBe("number");
    expect(Number.isFinite(payload.cost_delta_millicents!)).toBe(true);
  });

  it("cost_vs_baseline is a finite positive number", () => {
    const impact  = computeCostImpactFields(2000, 1000);
    const payload = redactForBroadcast(makeFleetRow({ cost_millicents: 2000 }), impact);

    expect(typeof payload.cost_vs_baseline).toBe("number");
    expect(Number.isFinite(payload.cost_vs_baseline!)).toBe(true);
    expect(payload.cost_vs_baseline!).toBeGreaterThanOrEqual(0);
  });

  it("variance_pct is a finite number in [−9999, 9999]", () => {
    const impact  = computeCostImpactFields(2000, 1000);
    const payload = redactForBroadcast(makeFleetRow({ cost_millicents: 2000 }), impact);

    expect(typeof payload.variance_pct).toBe("number");
    expect(Number.isFinite(payload.variance_pct!)).toBe(true);
    expect(payload.variance_pct!).toBeGreaterThanOrEqual(-9999);
    expect(payload.variance_pct!).toBeLessThanOrEqual(9999);
  });

  it("new cost-delta field names are not in FORBIDDEN_FIELDS", () => {
    const newFields = ["cost_delta_millicents", "cost_vs_baseline", "variance_pct"];
    for (const f of newFields) {
      expect(FORBIDDEN_FIELDS.has(f)).toBe(false);
    }
  });

  it("broadcast payload with cost-delta fields does not expose FORBIDDEN_FIELDS", () => {
    const impact  = computeCostImpactFields(3000, 1000);
    const payload = toFleetEventJSON(
      redactForBroadcast(makeFleetRow({ cost_millicents: 3000 }), impact),
    );
    const keys = new Set(Object.keys(payload));
    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Window arithmetic — manually simulate aggregation logic
//    (mirrors the CostWindowAggregator internals without importing the route)
// ---------------------------------------------------------------------------

describe("cost-impact window arithmetic", () => {
  /** Build a batch of events and compute what a flushed window should contain. */
  function simulateWindow(events: FleetRealtimeEvent[]): {
    totalMillicents: number;
    baselineMillicents: number;
    deltaMillicents: number;
    variancePct: number;
  } {
    let totalMillicents   = 0;
    let lastBaseline      = 0;
    let eventCount        = 0;

    for (const ev of events) {
      if (!ev.fleet_event) continue;
      totalMillicents += ev.cost_millicents ?? 0;
      if (ev.team_avg_millicents !== undefined) lastBaseline = ev.team_avg_millicents;
      eventCount++;
    }

    const baselineTotal   = lastBaseline * eventCount;
    const deltaMillicents = totalMillicents - baselineTotal;
    const variancePct     = baselineTotal > 0
      ? Number(Math.max(-9999, Math.min(9999, (deltaMillicents / baselineTotal) * 100)).toFixed(2))
      : (deltaMillicents > 0 ? 9999 : deltaMillicents < 0 ? -9999 : 0);

    return { totalMillicents, baselineMillicents: lastBaseline, deltaMillicents, variancePct };
  }

  it("sums costs across multiple events in a window", () => {
    const events = [
      redactForBroadcast(makeFleetRow({ cost_millicents: 1000, fleet_event: "proposal", fleet_outcome: "approved" }),  computeCostImpactFields(1000, 800)),
      redactForBroadcast(makeFleetRow({ cost_millicents: 2000, fleet_event: "merge",    fleet_outcome: "applied"  }),  computeCostImpactFields(2000, 800)),
    ];

    const result = simulateWindow(events);
    expect(result.totalMillicents).toBe(3000);
    expect(result.baselineMillicents).toBe(800);
    // delta = 3000 − (800 × 2) = 1400
    expect(result.deltaMillicents).toBe(1400);
  });

  it("computes correct variance_pct for a window", () => {
    const events = [
      redactForBroadcast(makeFleetRow({ cost_millicents: 1200, fleet_event: "proposal", fleet_outcome: "approved" }), computeCostImpactFields(1200, 1000)),
    ];

    const result = simulateWindow(events);
    // total = 1200, baseline = 1000×1 = 1000, delta = 200, variance = 20%
    expect(result.deltaMillicents).toBe(200);
    expect(result.variancePct).toBeCloseTo(20, 1);
  });

  it("variance_pct is 0 when all costs equal the baseline", () => {
    const events = [
      redactForBroadcast(makeFleetRow({ cost_millicents: 500, fleet_event: "heartbeat", fleet_outcome: "ok" }), computeCostImpactFields(500, 500)),
      redactForBroadcast(makeFleetRow({ cost_millicents: 500, fleet_event: "heartbeat", fleet_outcome: "ok" }), computeCostImpactFields(500, 500)),
    ];

    const result = simulateWindow(events);
    expect(result.deltaMillicents).toBe(0);
    expect(result.variancePct).toBeCloseTo(0, 2);
  });

  it("events with no fleet_event are excluded from the window", () => {
    const noFleet = redactForBroadcast(
      makeFleetRow({ fleet_event: null as unknown as string, cost_millicents: 9999 }),
    );
    const withFleet = redactForBroadcast(
      makeFleetRow({ fleet_event: "proposal", cost_millicents: 500 }),
      computeCostImpactFields(500, 500),
    );

    const result = simulateWindow([noFleet, withFleet]);
    // Only withFleet counts
    expect(result.totalMillicents).toBe(500);
  });
});
