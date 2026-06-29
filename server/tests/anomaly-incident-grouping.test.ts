/**
 * anomaly-incident-grouping.test.ts
 *
 * Unit tests for groupAnomaliesToIncidents() and findStaleIncidents().
 *
 * All functions are pure (no DB, no network) — tests run without any runtime
 * infrastructure. Covers:
 *
 *   1. New incident creation from an unmatched anomaly.
 *   2. Merging a second anomaly of the same kind into an open incident.
 *   3. Same-batch anomalies of the same kind merge into a single new incident.
 *   4. Closed incidents are ignored during matching.
 *   5. Out-of-window incidents (last_seen_at >2h ago) are ignored.
 *   6. Kind isolation — anomalies of different kinds never merge.
 *   7. Severity escalation — maxSeverity always picks the higher value.
 *   8. Cost impact accumulates across merged anomalies.
 *   9. Context arrays (repo_names, models, owners) union correctly.
 *  10. Integration: multi-kind batch produces correct created/updated split.
 *  11. findStaleIncidents returns only open incidents older than 4h.
 *  12. Org-wide anomalies (no repo/owner) merge with org-wide incidents.
 */

import { describe, expect, test } from "bun:test";
import {
  groupAnomaliesToIncidents,
  findStaleIncidents,
  maxSeverity,
  INCIDENT_MERGE_WINDOW_MS,
  INCIDENT_AUTO_CLOSE_MS,
  type AnomalyIncident,
} from "../src/lib/anomaly-incident-grouping";
import type { RealtimeAnomaly } from "../src/lib/realtime-anomaly";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnomaly(
  overrides: Partial<RealtimeAnomaly> & { kind: RealtimeAnomaly["kind"] },
): RealtimeAnomaly {
  return {
    kind:      overrides.kind,
    severity:  overrides.severity  ?? "low",
    message:   overrides.message   ?? `${overrides.kind} detected`,
    repo_name: overrides.repo_name ?? null,
    user_id:   overrides.user_id   ?? null,
    context:   overrides.context   ?? {},
  };
}

function makeIncident(
  overrides: Partial<AnomalyIncident> & { kind: string; last_seen_at: string },
): AnomalyIncident {
  return {
    id:                     overrides.id                     ?? "00000000-0000-0000-0000-000000000001",
    org_id:                 overrides.org_id                 ?? "org-1",
    first_detected_at:      overrides.first_detected_at      ?? overrides.last_seen_at,
    last_seen_at:           overrides.last_seen_at,
    closed_at:              overrides.closed_at              ?? null,
    kind:                   overrides.kind,
    severity:               overrides.severity               ?? "low",
    cost_impact_millicents: overrides.cost_impact_millicents ?? 0,
    event_count:            overrides.event_count            ?? 1,
    context:                overrides.context                ?? {
      repo_names: [],
      models:     [],
      owners:     [],
      span_ids:   [],
    },
  };
}

/** ISO timestamp offset from `now` by `offsetMs` (negative = past). */
function isoOffset(now: Date, offsetMs: number): string {
  return new Date(now.getTime() + offsetMs).toISOString();
}

// ─── maxSeverity ──────────────────────────────────────────────────────────────

describe("maxSeverity", () => {
  test("returns high when either is high", () => {
    expect(maxSeverity("high", "low")).toBe("high");
    expect(maxSeverity("low", "high")).toBe("high");
  });

  test("returns medium when comparing medium and low", () => {
    expect(maxSeverity("medium", "low")).toBe("medium");
    expect(maxSeverity("low", "medium")).toBe("medium");
  });

  test("returns same when equal", () => {
    expect(maxSeverity("high", "high")).toBe("high");
    expect(maxSeverity("low",  "low")).toBe("low");
  });
});

// ─── New incident creation ────────────────────────────────────────────────────

describe("groupAnomaliesToIncidents — new incident creation", () => {
  test("creates a new incident when no recent incidents exist", () => {
    const now = new Date();
    const anomaly = makeAnomaly({ kind: "cost_spike", severity: "medium", repo_name: "repo-a" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [], now);

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(0);

    const inc = created[0];
    expect(inc.kind).toBe("cost_spike");
    expect(inc.severity).toBe("medium");
    expect(inc.event_count).toBe(1);
    expect(inc.closed_at).toBeNull();
    expect(inc.context.repo_names).toContain("repo-a");
  });

  test("creates separate incidents for different kinds", () => {
    const now = new Date();
    const batch = [
      makeAnomaly({ kind: "cost_spike" }),
      makeAnomaly({ kind: "token_explosion" }),
    ];
    const { created, updated } = groupAnomaliesToIncidents(batch, [], now);

    expect(created).toHaveLength(2);
    expect(updated).toHaveLength(0);
    expect(created.map((i) => i.kind).sort()).toEqual(["cost_spike", "token_explosion"]);
  });

  test("sets first_detected_at and last_seen_at to now", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const { created } = groupAnomaliesToIncidents(
      [makeAnomaly({ kind: "model_thrash" })],
      [],
      now,
    );
    expect(created[0].first_detected_at).toBe(now.toISOString());
    expect(created[0].last_seen_at).toBe(now.toISOString());
  });

  test("captures cost impact from cost_spike anomaly context", () => {
    const now = new Date();
    const anomaly = makeAnomaly({
      kind:    "cost_spike",
      context: { batch_cost_millicents: 50_000 },
    });
    const { created } = groupAnomaliesToIncidents([anomaly], [], now);
    expect(created[0].cost_impact_millicents).toBe(50_000);
  });

  test("non-cost kinds have zero cost impact", () => {
    const { created } = groupAnomaliesToIncidents(
      [makeAnomaly({ kind: "tool_failure_rate" })],
      [],
    );
    expect(created[0].cost_impact_millicents).toBe(0);
  });
});

// ─── Merging within window ────────────────────────────────────────────────────

describe("groupAnomaliesToIncidents — merging within window", () => {
  test("merges anomaly into open incident of same kind within window", () => {
    const now = new Date();
    const recentTs = isoOffset(now, -30 * 60 * 1000); // 30 min ago

    const existing = makeIncident({
      kind:         "cost_spike",
      last_seen_at: recentTs,
      event_count:  1,
      context:      { repo_names: ["repo-a"], models: [], owners: [], span_ids: [] },
    });

    const anomaly = makeAnomaly({ kind: "cost_spike", repo_name: "repo-a" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);

    const inc = updated[0];
    expect(inc.event_count).toBe(2);
    expect(inc.last_seen_at).toBe(now.toISOString());
  });

  test("severity escalates on merge (low → high)", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:         "cost_spike",
      severity:     "low",
      last_seen_at: isoOffset(now, -30 * 60 * 1000),
    });

    const anomaly = makeAnomaly({ kind: "cost_spike", severity: "high" });
    const { updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(updated[0].severity).toBe("high");
  });

  test("severity does not downgrade on merge (high stays high)", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:         "cost_spike",
      severity:     "high",
      last_seen_at: isoOffset(now, -30 * 60 * 1000),
    });

    const anomaly = makeAnomaly({ kind: "cost_spike", severity: "low" });
    const { updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(updated[0].severity).toBe("high");
  });

  test("cost_impact accumulates on merge", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:                   "cost_spike",
      last_seen_at:           isoOffset(now, -30 * 60 * 1000),
      cost_impact_millicents: 10_000,
    });

    const anomaly = makeAnomaly({
      kind:    "cost_spike",
      context: { batch_cost_millicents: 25_000 },
    });
    const { updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(updated[0].cost_impact_millicents).toBe(35_000);
  });

  test("repo_names union across merge", () => {
    const now = new Date();
    // Incident is org-wide (no repo_names) so it absorbs any incoming scoped anomaly.
    const existing = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -10 * 60 * 1000),
      context:      { repo_names: [], models: [], owners: [], span_ids: [] },
    });

    const anomaly = makeAnomaly({ kind: "cost_spike", repo_name: "repo-b" });
    const { updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(updated).toHaveLength(1);
    expect(updated[0].context.repo_names).toContain("repo-b");
  });

  test("duplicate repo_names not added twice", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -5 * 60 * 1000),
      context:      { repo_names: ["repo-x"], models: [], owners: [], span_ids: [] },
    });

    const anomaly = makeAnomaly({ kind: "cost_spike", repo_name: "repo-x" });
    const { updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(updated[0].context.repo_names.filter((r) => r === "repo-x")).toHaveLength(1);
  });

  test("same-batch org-wide anomalies of same kind merge into single new incident", () => {
    const now = new Date();
    // Org-wide anomalies (no repo_name / user_id) always scope-overlap each other.
    const batch = [
      makeAnomaly({ kind: "tool_failure_rate" }),
      makeAnomaly({ kind: "tool_failure_rate" }),
    ];
    const { created, updated } = groupAnomaliesToIncidents(batch, [], now);

    // First anomaly creates a new incident; second merges into it (same run).
    // The new incident appears in `created`; after the second merge it also
    // appears in `updated` (same object reference). Total incidents = 1.
    expect(created).toHaveLength(1);
    // event_count should be 2 — both anomalies landed in the same incident.
    expect(created[0].event_count).toBe(2);
    // The merged incident is the same object in both lists (or just updated).
    const allIncidents = [...created, ...updated];
    const unique = new Set(allIncidents);
    expect(unique.size).toBe(1);
  });

  test("same-batch scoped anomalies with different repos each create their own incident", () => {
    const now = new Date();
    const batch = [
      makeAnomaly({ kind: "tool_failure_rate", repo_name: "repo-a" }),
      makeAnomaly({ kind: "tool_failure_rate", repo_name: "repo-b" }),
    ];
    const { created, updated } = groupAnomaliesToIncidents(batch, [], now);

    // Different repo scopes — no overlap, so two separate incidents.
    expect(created).toHaveLength(2);
    expect(updated).toHaveLength(0);
  });
});

// ─── Closed and out-of-window incidents ──────────────────────────────────────

describe("groupAnomaliesToIncidents — ignoring closed / stale incidents", () => {
  test("closed incident is not matched (creates new incident instead)", () => {
    const now = new Date();
    const closed = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -30 * 60 * 1000),
      closed_at:    isoOffset(now, -10 * 60 * 1000),
    });

    const anomaly = makeAnomaly({ kind: "cost_spike" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [closed], now);

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(0);
  });

  test("out-of-window incident (>2h old last_seen_at) is not matched", () => {
    const now = new Date();
    const stale = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -(INCIDENT_MERGE_WINDOW_MS + 1)),
    });

    const anomaly = makeAnomaly({ kind: "cost_spike" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [stale], now);

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(0);
  });

  test("incident exactly at window boundary (2h) is NOT matched", () => {
    const now = new Date();
    const boundary = makeIncident({
      kind:         "cache_miss_storm",
      last_seen_at: isoOffset(now, -INCIDENT_MERGE_WINDOW_MS),
    });

    const anomaly = makeAnomaly({ kind: "cache_miss_storm" });
    const { created } = groupAnomaliesToIncidents([anomaly], [boundary], now);

    // Exactly at boundary means age === INCIDENT_MERGE_WINDOW_MS which is NOT
    // within window (strict <). Should create a new incident.
    expect(created).toHaveLength(1);
  });

  test("incident 1 minute inside window is matched", () => {
    const now = new Date();
    const fresh = makeIncident({
      kind:         "cache_miss_storm",
      last_seen_at: isoOffset(now, -(INCIDENT_MERGE_WINDOW_MS - 60_000)),
    });

    const anomaly = makeAnomaly({ kind: "cache_miss_storm" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [fresh], now);

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
  });
});

// ─── Kind isolation ───────────────────────────────────────────────────────────

describe("groupAnomaliesToIncidents — kind isolation", () => {
  test("anomalies of different kinds never merge into each other", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -10 * 60 * 1000),
    });

    const anomaly = makeAnomaly({ kind: "model_thrash" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(0);
    expect(created[0].kind).toBe("model_thrash");
  });
});

// ─── Org-wide anomalies ───────────────────────────────────────────────────────

describe("groupAnomaliesToIncidents — org-wide scope", () => {
  test("org-wide anomaly (no repo/owner) merges into org-wide incident", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:         "peer_divergence",
      last_seen_at: isoOffset(now, -15 * 60 * 1000),
      // no repo_names, no owners — org-wide
    });

    const anomaly = makeAnomaly({ kind: "peer_divergence" }); // no repo_name / user_id
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
  });

  test("scoped anomaly merges into org-wide incident (org-wide absorbs all)", () => {
    const now = new Date();
    const existing = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -20 * 60 * 1000),
      // org-wide: no repo_names/owners
    });

    const anomaly = makeAnomaly({ kind: "cost_spike", repo_name: "repo-z" });
    const { created, updated } = groupAnomaliesToIncidents([anomaly], [existing], now);

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].context.repo_names).toContain("repo-z");
  });
});

// ─── Integration: multi-kind batch ───────────────────────────────────────────

describe("groupAnomaliesToIncidents — integration", () => {
  test("multi-kind batch creates correct incident split", () => {
    const now = new Date();

    // One existing open cost_spike incident.
    const existing = makeIncident({
      id:           "inc-001",
      kind:         "cost_spike",
      severity:     "low",
      last_seen_at: isoOffset(now, -45 * 60 * 1000),
      context:      { repo_names: ["repo-a"], models: [], owners: [], span_ids: [] },
    });

    const batch: RealtimeAnomaly[] = [
      // Should merge into existing cost_spike incident.
      makeAnomaly({ kind: "cost_spike", severity: "medium", repo_name: "repo-a", context: { batch_cost_millicents: 8_000 } }),
      // New kind — creates new incident.
      makeAnomaly({ kind: "token_explosion", severity: "high", repo_name: "repo-b" }),
      // Another cost_spike, same repo — still merges into same incident.
      makeAnomaly({ kind: "cost_spike", severity: "low", repo_name: "repo-a", context: { batch_cost_millicents: 2_000 } }),
    ];

    const { created, updated } = groupAnomaliesToIncidents(batch, [existing], now);

    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe("token_explosion");
    expect(created[0].severity).toBe("high");

    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("inc-001");
    // Merged 2 cost_spike anomalies.
    expect(updated[0].event_count).toBe(3); // 1 existing + 2 new
    // Severity escalates to medium.
    expect(updated[0].severity).toBe("medium");
    // Cost accumulates.
    expect(updated[0].cost_impact_millicents).toBe(10_000);
  });

  test("empty batch returns empty result", () => {
    const { created, updated } = groupAnomaliesToIncidents([], []);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});

// ─── findStaleIncidents ───────────────────────────────────────────────────────

describe("findStaleIncidents", () => {
  test("returns open incidents with last_seen_at older than 4h", () => {
    const now = new Date();
    const stale = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -(INCIDENT_AUTO_CLOSE_MS + 1)),
    });
    const result = findStaleIncidents([stale], now);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(stale);
  });

  test("does not return incident within 4h window", () => {
    const now = new Date();
    const fresh = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -(INCIDENT_AUTO_CLOSE_MS - 60_000)),
    });
    const result = findStaleIncidents([fresh], now);
    expect(result).toHaveLength(0);
  });

  test("does not return already-closed incidents", () => {
    const now = new Date();
    const alreadyClosed = makeIncident({
      kind:         "cost_spike",
      last_seen_at: isoOffset(now, -(INCIDENT_AUTO_CLOSE_MS + 1)),
      closed_at:    isoOffset(now, -60_000),
    });
    const result = findStaleIncidents([alreadyClosed], now);
    expect(result).toHaveLength(0);
  });

  test("returns multiple stale open incidents", () => {
    const now = new Date();
    const stale1 = makeIncident({ kind: "cost_spike",  last_seen_at: isoOffset(now, -(5 * 60 * 60 * 1000)) });
    const stale2 = makeIncident({ kind: "model_thrash", last_seen_at: isoOffset(now, -(6 * 60 * 60 * 1000)) });
    const fresh  = makeIncident({ kind: "tool_failure_rate", last_seen_at: isoOffset(now, -60_000) });

    const result = findStaleIncidents([stale1, stale2, fresh], now);
    expect(result).toHaveLength(2);
    expect(result).toContain(stale1);
    expect(result).toContain(stale2);
    expect(result).not.toContain(fresh);
  });

  test("empty input returns empty array", () => {
    expect(findStaleIncidents([])).toHaveLength(0);
  });
});
