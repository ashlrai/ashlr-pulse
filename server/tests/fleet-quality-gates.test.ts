/**
 * fleet-quality-gates.test.ts — boundary tests for the decision-quality gates.
 *
 * These are PURE-FUNCTION tests: each gate is fed a synthetic FleetMetrics
 * object (no DB, no network) and we assert it lands on the right status at and
 * around its threshold boundary. The boundary convention under test:
 *   - "higher is worse" gates (rejection, backlog, failed cmds, cost/applied,
 *     idle hours): a value AT the warn boundary ⇒ warn; AT the fail ⇒ fail.
 *   - "higher is better" gate (approval rate): a value AT the warn floor ⇒
 *     warn; AT the fail floor ⇒ fail.
 * Gates with a zero denominator (no resolved proposals) return 'pass' — we
 * assert that "no evidence" path too.
 */

import { describe, expect, test } from "bun:test";
import type { FleetMetrics } from "@/lib/fleet-oversight";
import {
  GATE_THRESHOLDS,
  gateApprovalRate,
  gateRejectionRate,
  gateReviewBacklog,
  gateFailedCommands,
  gateOverBudget,
  gateCostPerApplied,
  gateIdleStuck,
  gateImprovementTrend,
  scoreFleetHealth,
} from "@/lib/fleet-quality-gates";

// ---------------------------------------------------------------------------
// A neutral, all-green baseline. Every gate passes on this. Individual tests
// override just the fields their gate reads, so a failure is unambiguous.
// ---------------------------------------------------------------------------
function baseMetrics(overrides: DeepPartial<FleetMetrics> = {}): FleetMetrics {
  const base: FleetMetrics = {
    window: { start: "2026-06-18T00:00:00Z", end: "2026-06-25T00:00:00Z", days: 7 },
    productivity: {
      proposals: 40,
      perDay: 40 / 7,
      ticks: 200,
      activeAgents: 3,
      reposTouched: 4,
      costUsd: 12,
      costPerProposal: 0.3,
      appliedChanges: 30,
    },
    quality: {
      applied: 30,
      rejected: 5,
      pending: 5,
      resolved: 35,
      approvalRate: 30 / 35, // ~0.857
      rejectionRate: 5 / 35, // ~0.143
      avgHoursToReview: 4,
      staleReviewCount: 0,
    },
    impact: { reposImproved: 3, reposRegressed: 0, avgHealthScore: 82 },
    safety: { spendUsd: 12, budgetCapUsd: 100, overBudget: false, failedCommands: 0 },
    byEngine: [],
    byRepo: [],
    byOwner: [],
    trend: "improving",
  };
  return mergeDeep(base, overrides);
}

// minimal deep-merge so tests can override nested fields tersely.
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
function mergeDeep<T>(base: T, over: DeepPartial<T>): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const k of Object.keys(over) as Array<keyof T>) {
    const ov = (over as any)[k];
    if (ov && typeof ov === "object" && !Array.isArray(ov)) {
      out[k] = mergeDeep((base as any)[k], ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out as T;
}

/** Build a quality block with the given applied/rejected counts (pending=0). */
function quality(applied: number, rejected: number, extra: Partial<FleetMetrics["quality"]> = {}) {
  const resolved = applied + rejected;
  return {
    applied,
    rejected,
    pending: 0,
    resolved,
    approvalRate: resolved > 0 ? applied / resolved : 0,
    rejectionRate: resolved > 0 ? rejected / resolved : 0,
    avgHoursToReview: 4,
    staleReviewCount: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// approval-rate-floor
// ---------------------------------------------------------------------------
describe("gateApprovalRate", () => {
  const { warn, fail } = GATE_THRESHOLDS.approvalRate; // 0.5 / 0.3

  test("healthy rate passes", () => {
    expect(gateApprovalRate(baseMetrics()).status).toBe("pass");
  });

  test("at the warn floor ⇒ warn", () => {
    // 50 applied / 100 resolved = 0.50 exactly.
    const m = baseMetrics({ quality: quality(50, 50) });
    expect(m.quality.approvalRate).toBe(warn);
    expect(gateApprovalRate(m).status).toBe("warn");
  });

  test("just above the warn floor ⇒ pass", () => {
    const m = baseMetrics({ quality: quality(51, 49) }); // 0.51
    expect(gateApprovalRate(m).status).toBe("pass");
  });

  test("at the fail floor ⇒ fail", () => {
    const m = baseMetrics({ quality: quality(30, 70) }); // 0.30 exactly
    expect(m.quality.approvalRate).toBe(fail);
    expect(gateApprovalRate(m).status).toBe("fail");
  });

  test("zero resolved ⇒ pass with null actual (no evidence)", () => {
    const m = baseMetrics({ quality: quality(0, 0) });
    const r = gateApprovalRate(m);
    expect(r.status).toBe("pass");
    expect(r.actual).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rejection-rate-ceiling
// ---------------------------------------------------------------------------
describe("gateRejectionRate", () => {
  const { warn, fail } = GATE_THRESHOLDS.rejectionRate; // 0.4 / 0.6

  test("low rejection passes", () => {
    expect(gateRejectionRate(baseMetrics()).status).toBe("pass");
  });

  test("at the warn ceiling ⇒ warn", () => {
    const m = baseMetrics({ quality: quality(60, 40) }); // reject 0.40
    expect(m.quality.rejectionRate).toBe(warn);
    expect(gateRejectionRate(m).status).toBe("warn");
  });

  test("just below the warn ceiling ⇒ pass", () => {
    const m = baseMetrics({ quality: quality(61, 39) }); // 0.39
    expect(gateRejectionRate(m).status).toBe("pass");
  });

  test("at the fail ceiling ⇒ fail", () => {
    const m = baseMetrics({ quality: quality(40, 60) }); // 0.60
    expect(m.quality.rejectionRate).toBe(fail);
    expect(gateRejectionRate(m).status).toBe("fail");
  });

  test("zero resolved ⇒ pass", () => {
    expect(gateRejectionRate(baseMetrics({ quality: quality(0, 0) })).status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// review-backlog-ceiling
// ---------------------------------------------------------------------------
describe("gateReviewBacklog", () => {
  const { warn, fail } = GATE_THRESHOLDS.staleReviews; // 5 / 15

  test("no backlog passes", () => {
    expect(gateReviewBacklog(baseMetrics()).status).toBe("pass");
  });

  test("at the warn ceiling ⇒ warn", () => {
    const m = baseMetrics({ quality: { staleReviewCount: warn } });
    expect(gateReviewBacklog(m).status).toBe("warn");
  });

  test("just below warn ⇒ pass", () => {
    const m = baseMetrics({ quality: { staleReviewCount: warn - 1 } });
    expect(gateReviewBacklog(m).status).toBe("pass");
  });

  test("at the fail ceiling ⇒ fail", () => {
    const m = baseMetrics({ quality: { staleReviewCount: fail } });
    expect(gateReviewBacklog(m).status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// failed-command-ceiling
// ---------------------------------------------------------------------------
describe("gateFailedCommands", () => {
  const { warn, fail } = GATE_THRESHOLDS.failedCommands; // 1 / 5

  test("zero failures passes", () => {
    expect(gateFailedCommands(baseMetrics()).status).toBe("pass");
  });

  test("at the warn ceiling ⇒ warn", () => {
    expect(gateFailedCommands(baseMetrics({ safety: { failedCommands: warn } })).status).toBe("warn");
  });

  test("at the fail ceiling ⇒ fail", () => {
    expect(gateFailedCommands(baseMetrics({ safety: { failedCommands: fail } })).status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// over-budget
// ---------------------------------------------------------------------------
describe("gateOverBudget", () => {
  test("within budget passes", () => {
    const m = baseMetrics({ safety: { spendUsd: 50, budgetCapUsd: 100, overBudget: false } });
    expect(gateOverBudget(m).status).toBe("pass");
  });

  test("no cap set ⇒ pass", () => {
    const m = baseMetrics({ safety: { spendUsd: 999, budgetCapUsd: null, overBudget: false } });
    expect(gateOverBudget(m).status).toBe("pass");
  });

  test("at 90% of cap ⇒ warn", () => {
    const m = baseMetrics({ safety: { spendUsd: 90, budgetCapUsd: 100, overBudget: false } });
    expect(gateOverBudget(m).status).toBe("warn");
  });

  test("at the cap (ratio 1.0) ⇒ fail", () => {
    const m = baseMetrics({ safety: { spendUsd: 100, budgetCapUsd: 100, overBudget: false } });
    expect(gateOverBudget(m).status).toBe("fail");
  });

  test("explicit overBudget flag ⇒ fail even if ratio computed low", () => {
    const m = baseMetrics({ safety: { spendUsd: 10, budgetCapUsd: 100, overBudget: true } });
    expect(gateOverBudget(m).status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// cost-per-applied-ceiling
// ---------------------------------------------------------------------------
describe("gateCostPerApplied", () => {
  const { warn, fail } = GATE_THRESHOLDS.costPerApplied; // 5 / 20

  test("cheap changes pass", () => {
    const m = baseMetrics({
      safety: { spendUsd: 10 },
      productivity: { appliedChanges: 100 },
    });
    expect(gateCostPerApplied(m).status).toBe("pass"); // $0.10/applied
  });

  test("at the warn ceiling ⇒ warn", () => {
    // $50 / 10 applied = $5.00 exactly.
    const m = baseMetrics({ safety: { spendUsd: warn * 10 }, productivity: { appliedChanges: 10 } });
    expect(gateCostPerApplied(m).status).toBe("warn");
  });

  test("at the fail ceiling ⇒ fail", () => {
    const m = baseMetrics({ safety: { spendUsd: fail * 10 }, productivity: { appliedChanges: 10 } });
    expect(gateCostPerApplied(m).status).toBe("fail");
  });

  test("spend with zero applied ⇒ warn (no return)", () => {
    const m = baseMetrics({ safety: { spendUsd: 8 }, productivity: { appliedChanges: 0 } });
    const r = gateCostPerApplied(m);
    expect(r.status).toBe("warn");
    expect(r.actual).toBeNull();
  });

  test("no spend and zero applied ⇒ pass", () => {
    const m = baseMetrics({ safety: { spendUsd: 0 }, productivity: { appliedChanges: 0 } });
    expect(gateCostPerApplied(m).status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// idle-stuck
// ---------------------------------------------------------------------------
describe("gateIdleStuck", () => {
  const { warn, fail } = GATE_THRESHOLDS.idleHours; // 24 / 72

  test("active fleet (proposals>0) passes regardless of window", () => {
    const m = baseMetrics({ productivity: { proposals: 1 } });
    expect(gateIdleStuck(m).status).toBe("pass");
  });

  test("nothing enrolled and no proposals ⇒ pass (empty, not stuck)", () => {
    const m = baseMetrics({
      window: { start: "x", end: "y", days: 7 },
      productivity: { proposals: 0, activeAgents: 0, reposTouched: 0 },
    });
    expect(gateIdleStuck(m).status).toBe("pass");
  });

  test("enrolled but idle exactly at warn-hours window ⇒ warn", () => {
    // window of warn/24 days ⇒ exactly `warn` hours.
    const m = baseMetrics({
      window: { start: "x", end: "y", days: warn / 24 },
      productivity: { proposals: 0, activeAgents: 2, reposTouched: 2 },
    });
    expect(gateIdleStuck(m).status).toBe("warn");
  });

  test("enrolled but idle just under warn-hours ⇒ pass", () => {
    const m = baseMetrics({
      window: { start: "x", end: "y", days: (warn - 1) / 24 },
      productivity: { proposals: 0, activeAgents: 2, reposTouched: 2 },
    });
    expect(gateIdleStuck(m).status).toBe("pass");
  });

  test("enrolled and idle past fail-hours ⇒ fail", () => {
    const m = baseMetrics({
      window: { start: "x", end: "y", days: fail / 24 },
      productivity: { proposals: 0, activeAgents: 2, reposTouched: 2 },
    });
    expect(gateIdleStuck(m).status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// improvement-trend
// ---------------------------------------------------------------------------
describe("gateImprovementTrend", () => {
  test("improving ⇒ pass", () => {
    expect(gateImprovementTrend(baseMetrics({ trend: "improving" })).status).toBe("pass");
  });
  test("flat ⇒ pass", () => {
    // A steady fleet is operating correctly — only a regression fires this gate.
    expect(gateImprovementTrend(baseMetrics({ trend: "flat" })).status).toBe("pass");
  });
  test("regressing ⇒ fail", () => {
    expect(gateImprovementTrend(baseMetrics({ trend: "regressing" })).status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// scoreFleetHealth — rollup
// ---------------------------------------------------------------------------
describe("scoreFleetHealth", () => {
  test("all-green baseline ⇒ status pass, score 100", () => {
    const h = scoreFleetHealth(baseMetrics());
    expect(h.status).toBe("pass");
    expect(h.score).toBe(100);
    expect(h.gates.length).toBe(8);
    expect(h.window.days).toBe(7);
  });

  test("overall status is the worst individual gate", () => {
    // One failing gate (regressing trend) drags overall to fail.
    const h = scoreFleetHealth(baseMetrics({ trend: "regressing" }));
    expect(h.status).toBe("fail");
    expect(h.score).toBeLessThan(100);
  });

  test("a single warn ⇒ overall warn, score between 0 and 100", () => {
    // staleReviewCount at its warn boundary (5) trips exactly one warn gate.
    const h = scoreFleetHealth(
      baseMetrics({ quality: { staleReviewCount: 5 } }),
    );
    expect(h.status).toBe("warn");
    expect(h.score).toBeGreaterThan(0);
    expect(h.score).toBeLessThan(100);
  });

  test("multiple failures crater the score harder than one", () => {
    const one = scoreFleetHealth(baseMetrics({ trend: "regressing" }));
    const many = scoreFleetHealth(
      baseMetrics({
        trend: "regressing",
        quality: quality(10, 90, { staleReviewCount: 20 }), // approval+rejection+backlog fail
        safety: { spendUsd: 200, budgetCapUsd: 100, overBudget: true, failedCommands: 10 },
      }),
    );
    expect(many.score).toBeLessThan(one.score);
    expect(many.status).toBe("fail");
  });
});
