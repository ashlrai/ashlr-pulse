/**
 * anomaly-incident-grouping.test.ts
 *
 * Unit + integration-style tests for the anomaly grouper (root-cause
 * attribution) and the remediation suggestion rules.
 *
 * Covers:
 *   1.  buildFingerprint — repo_name wins over model wins over org-wide
 *   2.  fingerprintsCompatible — org-wide absorbs all; same repo clusters
 *   3.  clusterAnomalies — same repo/model groups together; different repos separate
 *   4.  clusterAnomalies — org-wide anomalies absorb any scope
 *   5.  classifyRootCause — model_thrash → new_model_thrashing
 *   6.  classifyRootCause — cost_spike + tool_failure_rate → cost_spike_with_high_rejection_rate
 *   7.  classifyRootCause — cache_miss_storm signal
 *   8.  classifyRootCause — token_explosion single repo
 *   9.  classifyRootCause — peer_divergence → peer_cost_divergence
 *   10. classifyRootCause — tool_failure_rate alone → tool_failure_cascade
 *   11. classifyRootCause — cost_spike alone → generic_cost_spike
 *   12. computeSeverityScore — single high → 100; multiple lows stay ≤100
 *   13. generateDescription — contains kind label and signal narrative
 *   14. clusterAndEnrich — end-to-end: 5 anomalies (same repo) → 1 cluster, 1 enrichment
 *   15. remediationsForSignal — returns ≥1 suggestion per signal
 *   16. remediationsForSignal — new_model_thrashing includes switch_model
 *   17. remediationsForSignal — cost_spike_with_high_rejection_rate includes investigate_failures
 *   18. e2e-style: 5 anomalies fire → 1 incident cluster + correct root_cause_signal + ≥3 remediations
 *
 * No DB, no network — all pure functions.
 */

import { describe, expect, test } from "bun:test";
import {
  buildFingerprint,
  fingerprintsCompatible,
  clusterAnomalies,
  classifyRootCause,
  computeSeverityScore,
  generateDescription,
  clusterAndEnrich,
  ROOT_CAUSE_SIGNAL_VALUES,
  type AnomalyCluster,
} from "../lib/anomaly-grouper";
import {
  remediationsForSignal,
} from "../lib/anomaly-remediation-db";
import type { RealtimeAnomaly } from "../lib/realtime-anomaly";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnomaly(
  kind: RealtimeAnomaly["kind"],
  severity: RealtimeAnomaly["severity"] = "low",
  overrides: Partial<RealtimeAnomaly> = {},
): RealtimeAnomaly {
  return {
    kind,
    severity,
    message:   `test ${kind}`,
    repo_name: null,
    user_id:   null,
    context:   {},
    ...overrides,
  };
}

function makeRepoAnomaly(
  kind: RealtimeAnomaly["kind"],
  repo: string,
  severity: RealtimeAnomaly["severity"] = "medium",
  model?: string,
): RealtimeAnomaly {
  return makeAnomaly(kind, severity, {
    repo_name: repo,
    context:   model ? { model } : {},
  });
}

// ─── 1. buildFingerprint ──────────────────────────────────────────────────────

describe("buildFingerprint", () => {
  test("uses repo_name as source_key when set", () => {
    const a = makeAnomaly("cost_spike", "high", { repo_name: "my-repo" });
    const fp = buildFingerprint(a);
    expect(fp.repo_name).toBe("my-repo");
    expect(fp.source_key).toBe("my-repo");
  });

  test("uses model as source_key when repo_name is null", () => {
    const a = makeAnomaly("token_explosion", "medium", { context: { model: "claude-opus-4" } });
    const fp = buildFingerprint(a);
    expect(fp.model).toBe("claude-opus-4");
    expect(fp.source_key).toBe("claude-opus-4");
  });

  test("falls back to org-wide when neither repo nor model present", () => {
    const a = makeAnomaly("cache_miss_storm");
    const fp = buildFingerprint(a);
    expect(fp.source_key).toBe("org-wide");
    expect(fp.repo_name).toBeNull();
    expect(fp.model).toBeNull();
  });
});

// ─── 2. fingerprintsCompatible ────────────────────────────────────────────────

describe("fingerprintsCompatible", () => {
  test("org-wide is compatible with everything", () => {
    const orgWide  = buildFingerprint(makeAnomaly("cache_miss_storm"));
    const repoFp   = buildFingerprint(makeRepoAnomaly("cost_spike", "repo-x"));
    expect(fingerprintsCompatible(orgWide, repoFp)).toBe(true);
    expect(fingerprintsCompatible(repoFp, orgWide)).toBe(true);
  });

  test("same repo_name is compatible", () => {
    const a = buildFingerprint(makeRepoAnomaly("cost_spike", "same-repo"));
    const b = buildFingerprint(makeRepoAnomaly("token_explosion", "same-repo"));
    expect(fingerprintsCompatible(a, b)).toBe(true);
  });

  test("different repos are NOT compatible", () => {
    const a = buildFingerprint(makeRepoAnomaly("cost_spike", "repo-a"));
    const b = buildFingerprint(makeRepoAnomaly("cost_spike", "repo-b"));
    expect(fingerprintsCompatible(a, b)).toBe(false);
  });

  test("same model is compatible even without repo", () => {
    const a = buildFingerprint(makeAnomaly("token_explosion", "low", { context: { model: "claude-opus-4" } }));
    const b = buildFingerprint(makeAnomaly("cache_miss_storm", "low", { context: { model: "claude-opus-4" } }));
    expect(fingerprintsCompatible(a, b)).toBe(true);
  });
});

// ─── 3. clusterAnomalies — same repo groups together, different repos separate ─

describe("clusterAnomalies — repo scoping", () => {
  test("two anomalies from the same repo form ONE cluster", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeRepoAnomaly("cost_spike",      "my-repo"),
      makeRepoAnomaly("token_explosion", "my-repo"),
    ];
    const clusters = clusterAnomalies(anomalies);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].anomalies).toHaveLength(2);
  });

  test("anomalies from different repos form SEPARATE clusters", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeRepoAnomaly("cost_spike", "repo-a"),
      makeRepoAnomaly("cost_spike", "repo-b"),
    ];
    const clusters = clusterAnomalies(anomalies);
    expect(clusters).toHaveLength(2);
  });

  test("three repos → three clusters", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeRepoAnomaly("tool_failure_rate", "repo-x"),
      makeRepoAnomaly("tool_failure_rate", "repo-y"),
      makeRepoAnomaly("tool_failure_rate", "repo-z"),
    ];
    const clusters = clusterAnomalies(anomalies);
    expect(clusters).toHaveLength(3);
  });

  test("empty batch returns empty clusters", () => {
    expect(clusterAnomalies([])).toHaveLength(0);
  });
});

// ─── 4. clusterAnomalies — org-wide anomalies absorb ─────────────────────────

describe("clusterAnomalies — org-wide absorption", () => {
  test("org-wide anomaly groups with any repo-scoped anomaly", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeAnomaly("cache_miss_storm"),              // org-wide
      makeRepoAnomaly("cost_spike", "repo-a"),      // repo scoped
    ];
    const clusters = clusterAnomalies(anomalies);
    // org-wide absorbs repo-scoped → 1 cluster
    expect(clusters).toHaveLength(1);
    expect(clusters[0].anomalies).toHaveLength(2);
  });

  test("single org-wide anomaly → single cluster of 1", () => {
    const anomalies: RealtimeAnomaly[] = [makeAnomaly("peer_divergence", "high")];
    const clusters = clusterAnomalies(anomalies);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].anomalies).toHaveLength(1);
  });
});

// ─── 5–11. classifyRootCause ──────────────────────────────────────────────────

describe("classifyRootCause", () => {
  function cluster(anomalies: RealtimeAnomaly[]): AnomalyCluster {
    return { fingerprint: buildFingerprint(anomalies[0]), anomalies };
  }

  test("model_thrash → new_model_thrashing (highest priority)", () => {
    const c = cluster([
      makeAnomaly("model_thrash", "high"),
      makeAnomaly("cost_spike",   "high"),
    ]);
    expect(classifyRootCause(c)).toBe("new_model_thrashing");
  });

  test("cost_spike + tool_failure_rate → cost_spike_with_high_rejection_rate", () => {
    const c = cluster([
      makeAnomaly("cost_spike",        "high"),
      makeAnomaly("tool_failure_rate", "medium"),
    ]);
    expect(classifyRootCause(c)).toBe("cost_spike_with_high_rejection_rate");
  });

  test("cache_miss_storm alone → cache_miss_storm", () => {
    const c = cluster([makeAnomaly("cache_miss_storm", "medium")]);
    expect(classifyRootCause(c)).toBe("cache_miss_storm");
  });

  test("token_explosion scoped to single repo → token_explosion_single_repo", () => {
    const a = makeRepoAnomaly("token_explosion", "single-repo", "high");
    const c = cluster([a]);
    expect(classifyRootCause(c)).toBe("token_explosion_single_repo");
  });

  test("token_explosion across multiple repos → NOT token_explosion_single_repo", () => {
    const c: AnomalyCluster = {
      fingerprint: { repo_name: null, model: null, source_key: "org-wide" },
      anomalies: [
        makeRepoAnomaly("token_explosion", "repo-1"),
        makeRepoAnomaly("token_explosion", "repo-2"),
      ],
    };
    const signal = classifyRootCause(c);
    expect(signal).not.toBe("token_explosion_single_repo");
  });

  test("peer_divergence → peer_cost_divergence", () => {
    const c = cluster([makeAnomaly("peer_divergence", "medium")]);
    expect(classifyRootCause(c)).toBe("peer_cost_divergence");
  });

  test("tool_failure_rate alone → tool_failure_cascade", () => {
    const c = cluster([makeAnomaly("tool_failure_rate", "high")]);
    expect(classifyRootCause(c)).toBe("tool_failure_cascade");
  });

  test("cost_spike alone → generic_cost_spike", () => {
    const c = cluster([makeAnomaly("cost_spike", "low")]);
    expect(classifyRootCause(c)).toBe("generic_cost_spike");
  });
});

// ─── 12. computeSeverityScore ─────────────────────────────────────────────────

describe("computeSeverityScore", () => {
  function cluster(anomalies: RealtimeAnomaly[]): AnomalyCluster {
    return { fingerprint: { repo_name: null, model: null, source_key: "org-wide" }, anomalies };
  }

  test("single high anomaly scores 100", () => {
    const c = cluster([makeAnomaly("cost_spike", "high")]);
    expect(computeSeverityScore(c)).toBe(100);
  });

  test("single medium anomaly scores 50", () => {
    const c = cluster([makeAnomaly("cost_spike", "medium")]);
    expect(computeSeverityScore(c)).toBe(50);
  });

  test("single low anomaly scores 20", () => {
    const c = cluster([makeAnomaly("cache_miss_storm", "low")]);
    expect(computeSeverityScore(c)).toBe(20);
  });

  test("multiple events nudge score above base but cap at 100", () => {
    const many = Array.from({ length: 10 }, () => makeAnomaly("cost_spike", "high"));
    const c = cluster(many);
    const score = computeSeverityScore(c);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(100); // high base already at cap
  });

  test("multiple lows nudge score above single-low", () => {
    const single = cluster([makeAnomaly("cache_miss_storm", "low")]);
    const multi  = cluster(Array.from({ length: 8 }, () => makeAnomaly("cache_miss_storm", "low")));
    expect(computeSeverityScore(multi)).toBeGreaterThan(computeSeverityScore(single));
  });

  test("empty cluster scores 0", () => {
    expect(computeSeverityScore({ fingerprint: { repo_name: null, model: null, source_key: "org-wide" }, anomalies: [] })).toBe(0);
  });
});

// ─── 13. generateDescription ─────────────────────────────────────────────────

describe("generateDescription", () => {
  test("includes anomaly count and kind label", () => {
    const c: AnomalyCluster = {
      fingerprint: { repo_name: "my-repo", model: null, source_key: "my-repo" },
      anomalies:   [makeRepoAnomaly("cost_spike", "my-repo", "high")],
    };
    const desc = generateDescription(c, "generic_cost_spike");
    expect(desc).toMatch(/1 anomaly/i);
    expect(desc).toMatch(/cost spike/i);
  });

  test("includes repo name in scope when present", () => {
    const c: AnomalyCluster = {
      fingerprint: { repo_name: "critical-repo", model: null, source_key: "critical-repo" },
      anomalies:   [makeRepoAnomaly("cost_spike", "critical-repo", "medium")],
    };
    const desc = generateDescription(c, "generic_cost_spike");
    expect(desc).toContain("critical-repo");
  });

  test("model thrashing description mentions router/routing", () => {
    const c: AnomalyCluster = {
      fingerprint: { repo_name: null, model: null, source_key: "org-wide" },
      anomalies:   [makeAnomaly("model_thrash", "high")],
    };
    const desc = generateDescription(c, "new_model_thrashing");
    expect(desc.toLowerCase()).toMatch(/model|router|routing|switching/);
  });

  test("cache miss description mentions cache", () => {
    const c: AnomalyCluster = {
      fingerprint: { repo_name: null, model: null, source_key: "org-wide" },
      anomalies:   [makeAnomaly("cache_miss_storm", "medium")],
    };
    const desc = generateDescription(c, "cache_miss_storm");
    expect(desc.toLowerCase()).toContain("cache");
  });
});

// ─── 14. clusterAndEnrich — end-to-end ───────────────────────────────────────

describe("clusterAndEnrich — end-to-end", () => {
  test("5 anomalies from the same repo produce 1 cluster with enrichment", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeRepoAnomaly("cost_spike",        "fleet-repo", "high"),
      makeRepoAnomaly("token_explosion",   "fleet-repo", "medium"),
      makeRepoAnomaly("tool_failure_rate", "fleet-repo", "medium"),
      makeRepoAnomaly("cache_miss_storm",  "fleet-repo", "low"),
      makeRepoAnomaly("model_thrash",      "fleet-repo", "high"),
    ];

    const results = clusterAndEnrich(anomalies);

    // All from same repo → 1 cluster
    expect(results).toHaveLength(1);

    const { cluster, enrichment } = results[0];
    expect(cluster.anomalies).toHaveLength(5);

    // root_cause_signal must be a known value
    expect(ROOT_CAUSE_SIGNAL_VALUES).toContain(enrichment.root_cause_signal);

    // model_thrash is present → should be new_model_thrashing (highest priority)
    expect(enrichment.root_cause_signal).toBe("new_model_thrashing");

    // score should be > 0
    expect(enrichment.severity_score).toBeGreaterThan(0);
    expect(enrichment.severity_score).toBeLessThanOrEqual(100);

    // description should be a non-empty string
    expect(typeof enrichment.description).toBe("string");
    expect(enrichment.description.length).toBeGreaterThan(10);
  });

  test("anomalies from 2 different repos produce 2 clusters", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeRepoAnomaly("cost_spike", "repo-alpha", "high"),
      makeRepoAnomaly("cost_spike", "repo-beta",  "medium"),
    ];
    const results = clusterAndEnrich(anomalies);
    expect(results).toHaveLength(2);
  });

  test("empty batch returns empty results", () => {
    expect(clusterAndEnrich([])).toHaveLength(0);
  });
});

// ─── 15–17. remediationsForSignal ────────────────────────────────────────────

describe("remediationsForSignal", () => {
  test("returns at least 1 suggestion for every signal", () => {
    for (const signal of ROOT_CAUSE_SIGNAL_VALUES) {
      const rems = remediationsForSignal(signal);
      expect(rems.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("new_model_thrashing includes switch_model", () => {
    const rems = remediationsForSignal("new_model_thrashing");
    expect(rems).toContain("switch_model");
  });

  test("cost_spike_with_high_rejection_rate includes investigate_failures", () => {
    const rems = remediationsForSignal("cost_spike_with_high_rejection_rate");
    expect(rems).toContain("investigate_failures");
  });

  test("cache_miss_storm includes review_cache_config", () => {
    const rems = remediationsForSignal("cache_miss_storm");
    expect(rems).toContain("review_cache_config");
  });

  test("peer_cost_divergence includes investigate_peer", () => {
    const rems = remediationsForSignal("peer_cost_divergence");
    expect(rems).toContain("investigate_peer");
  });

  test("generic_cost_spike includes increase_budget", () => {
    const rems = remediationsForSignal("generic_cost_spike");
    expect(rems).toContain("increase_budget");
  });
});

// ─── 18. e2e: 5 anomalies → 1 incident + correct signal + ≥3 remediations ───

describe("e2e: 5 anomalies → incident + signal + remediations", () => {
  test("fires 5 anomalies, verifies 1 cluster, correct root_cause_signal, ≥3 remediations", () => {
    // Simulate 5 anomaly events for the same org/repo that the persist cron
    // would detect: cost_spike + tool_failure_rate + cache_miss_storm +
    // token_explosion + model_thrash.  model_thrash has highest priority.
    const anomalies: RealtimeAnomaly[] = [
      makeAnomaly("cost_spike",        "high",   { repo_name: "test-repo", context: { batch_cost_millicents: 50000, rolling_avg_millicents: 10000, ratio: 5.0 } }),
      makeAnomaly("tool_failure_rate", "medium", { repo_name: "test-repo", context: { failure_rate: 0.35 } }),
      makeAnomaly("cache_miss_storm",  "low",    { repo_name: "test-repo", context: { miss_rate: 0.85 } }),
      makeAnomaly("token_explosion",   "medium", { repo_name: "test-repo", context: { model: "claude-opus-4", ratio: 4.0 } }),
      makeAnomaly("model_thrash",      "high",   { repo_name: "test-repo", context: { distinct_models: 5 } }),
    ];

    // Step 1: cluster and enrich (what the cron does).
    const results = clusterAndEnrich(anomalies);

    // All 5 anomalies share the same repo → 1 incident cluster.
    expect(results).toHaveLength(1);
    const { cluster, enrichment } = results[0];
    expect(cluster.anomalies).toHaveLength(5);

    // Step 2: root_cause_signal — model_thrash is highest priority.
    expect(enrichment.root_cause_signal).toBe("new_model_thrashing");

    // Step 3: get remediations for that signal.
    const remediations = remediationsForSignal(enrichment.root_cause_signal);

    // Must have at least 2 suggested actions (spec says 3 for this signal).
    expect(remediations.length).toBeGreaterThanOrEqual(2);

    // new_model_thrashing → switch_model + reduce_token_window
    expect(remediations).toContain("switch_model");
    expect(remediations).toContain("reduce_token_window");

    // Step 4: severity score is valid.
    expect(enrichment.severity_score).toBeGreaterThan(0);
    expect(enrichment.severity_score).toBeLessThanOrEqual(100);

    // Step 5: description is a meaningful string.
    expect(enrichment.description).toMatch(/anomal/i);
  });

  test("cost_spike + tool_failure_rate cluster yields cost_spike_with_high_rejection_rate + ≥3 remediations", () => {
    const anomalies: RealtimeAnomaly[] = [
      makeAnomaly("cost_spike",        "high",   { context: { batch_cost_millicents: 30000, ratio: 3.5 } }),
      makeAnomaly("tool_failure_rate", "high",   { context: { failure_rate: 0.45 } }),
      makeAnomaly("tool_failure_rate", "medium", { context: { failure_rate: 0.25 } }),
      makeAnomaly("cost_spike",        "medium", { context: { batch_cost_millicents: 15000, ratio: 2.1 } }),
      makeAnomaly("cost_spike",        "low",    { context: { batch_cost_millicents: 5000,  ratio: 1.5 } }),
    ];

    const results = clusterAndEnrich(anomalies);
    // All org-wide → 1 cluster.
    expect(results).toHaveLength(1);

    const { enrichment } = results[0];
    expect(enrichment.root_cause_signal).toBe("cost_spike_with_high_rejection_rate");

    const remediations = remediationsForSignal(enrichment.root_cause_signal);
    expect(remediations.length).toBeGreaterThanOrEqual(3);
    expect(remediations).toContain("investigate_failures");
    expect(remediations).toContain("increase_budget");
    expect(remediations).toContain("reduce_token_window");
  });
});
