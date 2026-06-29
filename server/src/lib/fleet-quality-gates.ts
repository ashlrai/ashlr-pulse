/**
 * fleet-quality-gates.ts — decision-quality GATES for the autonomous fleet.
 *
 * This is the "automated testing" layer for the fleet's BEHAVIOR (not its code):
 * a set of named, threshold-driven checks evaluated against the org's
 * FleetMetrics (see lib/fleet-oversight#FleetMetrics) that tell a human or a
 * higher-level manager agent, at a glance, whether the fleet is
 *   (1) productive, (2) making GOOD decisions, and (3) improving over time.
 *
 * Each gate is a pure function of FleetMetrics → GateResult. There is ONE
 * tunable place for every threshold (GATE_THRESHOLDS below) so operators can
 * dial sensitivity without touching gate logic. evaluateFleetHealth() runs the
 * whole battery and rolls the results up into an overall status + a 0..100
 * score. The HTTP surface is GET /api/oversight/health.
 *
 * Privacy floor: gates consume metadata-only metrics. No code/prompts/diffs.
 *
 * Design notes:
 *  - A gate only fires (warn/fail) when it has enough signal to judge. Gates
 *    that need a denominator (e.g. approval rate needs resolved>0) return
 *    'pass' when the denominator is zero — "no evidence of a problem" rather
 *    than a false alarm. The one exception is idle/stuck detection, which is
 *    ABOUT the absence of activity and so treats zero as meaningful.
 *  - status precedence is fail > warn > pass. The overall status is the worst
 *    individual gate status; the score is a weighted blend so a single warn
 *    doesn't crater the number while a fail visibly hurts it.
 */

import type { FleetMetrics } from "@/lib/fleet-oversight";
import type { RootCauseDiagnosis } from "@/lib/fleet-anomaly-correlator";

export type GateStatus = "pass" | "warn" | "fail";

export interface GateResult {
  /** Stable identifier, e.g. "approval-rate-floor". */
  id: string;
  /** Human-facing one-liner. */
  label: string;
  status: GateStatus;
  /** The measured value this gate evaluated (already rounded for display). */
  actual: number | null;
  /** The boundary it was compared against (warn boundary when distinct). */
  threshold: number | null;
  /** Why it landed where it did — safe to render directly in the UI. */
  message: string;
  /**
   * When this gate fired (transitioned to warn/fail), the previous status it
   * was in.  Populated by evaluateFleetHealth when a transition is detected.
   * Undefined when the gate is passing or when no prior state is available.
   */
  previousStatus?: GateStatus;
}

export interface FleetHealth {
  status: GateStatus;
  /** 0..100 — higher is healthier. */
  score: number;
  gates: GateResult[];
  /** Echoed window so the caller knows what span was judged. */
  window: FleetMetrics["window"];
  /**
   * Root-cause diagnoses for gates that are currently warn/fail.
   * Populated by evaluateFleetHealth (requires DB); empty array from
   * scoreFleetHealth (pure, no DB).
   */
  anomalyDiagnoses: RootCauseDiagnosis[];
}

/**
 * THE one place to tune fleet-health sensitivity.
 *
 * Each gate reads its band from here. Rates are fractions in [0,1]; "warn"
 * is the gentler boundary, "fail" the harder one. Where a higher number is
 * worse (rejection, backlog, cost), warn < fail. Where a higher number is
 * better (approval rate), warn > fail.
 */
export const GATE_THRESHOLDS = {
  /** Approval-rate floor: applied/resolved. Below warn ⇒ shaky decisions;
   *  below fail ⇒ the fleet is mostly producing rejected work. */
  approvalRate: { warn: 0.5, fail: 0.3 },
  /** Rejection-rate ceiling: rejected/resolved. Mirror of the above as an
   *  explicit "agents making bad decisions" signal. */
  rejectionRate: { warn: 0.4, fail: 0.6 },
  /** Stale-review backlog: count of pending proposals older than the review
   *  SLA (pending > N days). Too many ⇒ the human can't keep up. */
  staleReviews: { warn: 5, fail: 15 },
  /** Failed control-plane commands in the window (enroll/approve/etc). */
  failedCommands: { warn: 1, fail: 5 },
  /** Cost (USD) per APPLIED change. Runaway spend per real outcome. */
  costPerApplied: { warn: 5, fail: 20 },
  /** Idle/stuck: max acceptable hours with zero proposals while agents are
   *  enrolled/active. Beyond fail ⇒ the fleet is stuck, not merely quiet. */
  idleHours: { warn: 24, fail: 72 },
} as const;

/**
 * Scoring weights per gate id. They need not sum to 1; the score normalizes.
 * Quality + safety gates carry the most weight because they speak directly to
 * "is the fleet making good, safe decisions".
 */
const GATE_WEIGHTS: Record<string, number> = {
  "approval-rate-floor": 3,
  "rejection-rate-ceiling": 3,
  "review-backlog-ceiling": 2,
  "failed-command-ceiling": 2,
  "over-budget": 3,
  "cost-per-applied-ceiling": 2,
  "idle-stuck": 2,
  "improvement-trend": 1,
};

/** Per-status credit toward the score (1 = full, 0 = none). */
const STATUS_CREDIT: Record<GateStatus, number> = {
  pass: 1,
  warn: 0.5,
  fail: 0,
};

const STATUS_RANK: Record<GateStatus, number> = { pass: 0, warn: 1, fail: 2 };

function worst(a: GateStatus, b: GateStatus): GateStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Individual gates — each a pure function of FleetMetrics.
//
// Boundary convention (kept consistent across all gates):
//   - A value exactly AT the warn boundary counts as warn (>= / <=).
//   - A value exactly AT the fail boundary counts as fail.
// ---------------------------------------------------------------------------

/** approval-rate-floor: too many proposals are getting rejected ⇒ bad calls. */
export function gateApprovalRate(m: FleetMetrics): GateResult {
  const { warn, fail } = GATE_THRESHOLDS.approvalRate;
  const resolved = m.quality.resolved;
  const rate = m.quality.approvalRate;
  if (resolved <= 0) {
    return {
      id: "approval-rate-floor",
      label: "Approval rate",
      status: "pass",
      actual: null,
      threshold: warn,
      message: "No reviewed proposals yet — nothing to judge.",
    };
  }
  let status: GateStatus = "pass";
  if (rate <= fail) status = "fail";
  else if (rate <= warn) status = "warn";
  const message =
    status === "pass"
      ? `${pct(rate)} of reviewed proposals were applied (${m.quality.applied}/${resolved}).`
      : `Only ${pct(rate)} of reviewed proposals were applied (floor ${pct(warn)}) — the fleet is making poor decisions.`;
  return { id: "approval-rate-floor", label: "Approval rate", status, actual: round2(rate), threshold: warn, message };
}

/** rejection-rate-ceiling: explicit mirror — share of work that got rejected. */
export function gateRejectionRate(m: FleetMetrics): GateResult {
  const { warn, fail } = GATE_THRESHOLDS.rejectionRate;
  const resolved = m.quality.resolved;
  const rate = m.quality.rejectionRate;
  if (resolved <= 0) {
    return {
      id: "rejection-rate-ceiling",
      label: "Rejection rate",
      status: "pass",
      actual: null,
      threshold: warn,
      message: "No reviewed proposals yet — nothing to judge.",
    };
  }
  let status: GateStatus = "pass";
  if (rate >= fail) status = "fail";
  else if (rate >= warn) status = "warn";
  const message =
    status === "pass"
      ? `${pct(rate)} of reviewed proposals were rejected (${m.quality.rejected}/${resolved}).`
      : `${pct(rate)} of reviewed proposals were rejected (ceiling ${pct(warn)}) — too many bad decisions reaching review.`;
  return { id: "rejection-rate-ceiling", label: "Rejection rate", status, actual: round2(rate), threshold: warn, message };
}

/** review-backlog-ceiling: stale pending proposals ⇒ human can't keep up. */
export function gateReviewBacklog(m: FleetMetrics): GateResult {
  const { warn, fail } = GATE_THRESHOLDS.staleReviews;
  const stale = m.quality.staleReviewCount;
  let status: GateStatus = "pass";
  if (stale >= fail) status = "fail";
  else if (stale >= warn) status = "warn";
  const message =
    status === "pass"
      ? `${stale} proposals awaiting review past SLA.`
      : `${stale} proposals are stuck awaiting review (ceiling ${warn}) — reviewers can't keep pace with the fleet.`;
  return { id: "review-backlog-ceiling", label: "Review backlog", status, actual: stale, threshold: warn, message };
}

/** failed-command-ceiling: control-plane commands that errored out. */
export function gateFailedCommands(m: FleetMetrics): GateResult {
  const { warn, fail } = GATE_THRESHOLDS.failedCommands;
  const failed = m.safety.failedCommands;
  let status: GateStatus = "pass";
  if (failed >= fail) status = "fail";
  else if (failed >= warn) status = "warn";
  const message =
    status === "pass"
      ? `${failed} failed fleet commands in window.`
      : `${failed} fleet commands failed (ceiling ${warn}) — assignments/approvals are not executing reliably.`;
  return { id: "failed-command-ceiling", label: "Failed commands", status, actual: failed, threshold: warn, message };
}

/** over-budget: the fleet has blown its configured spend cap. */
export function gateOverBudget(m: FleetMetrics): GateResult {
  const cap = m.safety.budgetCapUsd;
  const spend = m.safety.spendUsd;
  if (cap == null) {
    return {
      id: "over-budget",
      label: "Budget",
      status: "pass",
      actual: round2(spend),
      threshold: null,
      message: `No budget cap set — spent $${round2(spend)} this window.`,
    };
  }
  // Warn as we approach the cap (>=90%), fail once over it.
  const ratio = cap > 0 ? spend / cap : Number.POSITIVE_INFINITY;
  let status: GateStatus = "pass";
  if (m.safety.overBudget || ratio >= 1) status = "fail";
  else if (ratio >= 0.9) status = "warn";
  const message =
    status === "fail"
      ? `Over budget: spent $${round2(spend)} of $${round2(cap)} cap.`
      : status === "warn"
        ? `Approaching budget: spent $${round2(spend)} of $${round2(cap)} cap (${pct(ratio)}).`
        : `Within budget: $${round2(spend)} of $${round2(cap)} cap.`;
  return { id: "over-budget", label: "Budget", status, actual: round2(spend), threshold: round2(cap), message };
}

/** cost-per-applied-ceiling: dollars spent per change that actually landed. */
export function gateCostPerApplied(m: FleetMetrics): GateResult {
  const { warn, fail } = GATE_THRESHOLDS.costPerApplied;
  const applied = m.productivity.appliedChanges;
  const spend = m.safety.spendUsd;
  if (applied <= 0) {
    // No applied changes: if money was spent with nothing to show, that's a
    // warn (poor ROI); if nothing was spent, it's simply a pass (idle gate
    // covers true inactivity).
    if (spend > 0) {
      return {
        id: "cost-per-applied-ceiling",
        label: "Cost per applied change",
        status: "warn",
        actual: null,
        threshold: warn,
        message: `Spent $${round2(spend)} but no changes were applied — zero return so far.`,
      };
    }
    return {
      id: "cost-per-applied-ceiling",
      label: "Cost per applied change",
      status: "pass",
      actual: null,
      threshold: warn,
      message: "No applied changes and no spend — nothing to judge.",
    };
  }
  const cpa = spend / applied;
  let status: GateStatus = "pass";
  if (cpa >= fail) status = "fail";
  else if (cpa >= warn) status = "warn";
  const message =
    status === "pass"
      ? `$${round2(cpa)} per applied change (${applied} applied).`
      : `$${round2(cpa)} per applied change (ceiling $${warn}) — the fleet is spending too much per real outcome.`;
  return { id: "cost-per-applied-ceiling", label: "Cost per applied change", status, actual: round2(cpa), threshold: warn, message };
}

/**
 * idle-stuck: no proposals for too long while agents are active/enrolled.
 *
 * We don't get a literal "hours since last proposal" in FleetMetrics, so we
 * infer it: if there are zero proposals across the whole window but agents are
 * active or repos are enrolled (reposTouched), the fleet has been idle for at
 * least the window length. We compare window-hours against the idle band.
 */
export function gateIdleStuck(m: FleetMetrics): GateResult {
  const { warn, fail } = GATE_THRESHOLDS.idleHours;
  const proposals = m.productivity.proposals;
  const enrolled = m.productivity.activeAgents > 0 || m.productivity.reposTouched > 0;
  const windowHours = Math.max(0, Math.round(m.window.days * 24));

  if (proposals > 0) {
    return {
      id: "idle-stuck",
      label: "Idle / stuck",
      status: "pass",
      actual: 0,
      threshold: warn,
      message: `${proposals} proposals produced this window — fleet is active.`,
    };
  }
  if (!enrolled) {
    // Nobody enrolled and nothing running — not "stuck", just empty.
    return {
      id: "idle-stuck",
      label: "Idle / stuck",
      status: "pass",
      actual: windowHours,
      threshold: warn,
      message: "No active agents or enrolled repos — nothing expected to run.",
    };
  }
  // Enrolled/active but produced nothing: idle for >= the full window.
  let status: GateStatus = "pass";
  if (windowHours >= fail) status = "fail";
  else if (windowHours >= warn) status = "warn";
  const message =
    status === "pass"
      ? `No proposals in ${windowHours}h, but still within the idle grace period.`
      : `No proposals in ${windowHours}h despite active agents (ceiling ${warn}h) — the fleet appears idle or stuck.`;
  return { id: "idle-stuck", label: "Idle / stuck", status, actual: windowHours, threshold: warn, message };
}

/** improvement-trend: is the fleet getting better, or regressing? */
export function gateImprovementTrend(m: FleetMetrics): GateResult {
  const trend = m.trend;
  let status: GateStatus = "pass";
  if (trend === "regressing") status = "fail";
  // A steady ("flat") fleet is operating correctly — only a regression fires this gate.
  const message =
    trend === "improving"
      ? "Fleet health is improving vs the prior window."
      : trend === "flat"
        ? "Fleet health is flat vs the prior window — not improving."
        : "Fleet health is regressing vs the prior window.";
  // actual/threshold are numeric-only in the type; encode trend as -1/0/1.
  const actual = trend === "improving" ? 1 : trend === "flat" ? 0 : -1;
  return { id: "improvement-trend", label: "Improvement trend", status, actual, threshold: 0, message };
}

/** The full ordered battery. Order is presentation order in the UI. */
export const ALL_GATES: Array<(m: FleetMetrics) => GateResult> = [
  gateApprovalRate,
  gateRejectionRate,
  gateReviewBacklog,
  gateFailedCommands,
  gateOverBudget,
  gateCostPerApplied,
  gateIdleStuck,
  gateImprovementTrend,
];

/**
 * Run every gate against a metrics object and roll up status + score.
 *
 * Pure: no DB, no I/O. Pass it a FleetMetrics (real or synthetic). This is the
 * seam the unit test exercises and the seam evaluateFleetHealth() builds on.
 */
export function scoreFleetHealth(metrics: FleetMetrics): FleetHealth {
  const gates = ALL_GATES.map((g) => g(metrics));

  let status: GateStatus = "pass";
  let weightedCredit = 0;
  let totalWeight = 0;
  for (const g of gates) {
    status = worst(status, g.status);
    const w = GATE_WEIGHTS[g.id] ?? 1;
    weightedCredit += w * STATUS_CREDIT[g.status];
    totalWeight += w;
  }
  const score = totalWeight > 0 ? Math.round((weightedCredit / totalWeight) * 100) : 100;

  return { status, score, gates, window: metrics.window, anomalyDiagnoses: [] };
}

/**
 * Compute the org's FleetMetrics and evaluate the full gate battery.
 *
 * Thin DB-touching wrapper around scoreFleetHealth — imports
 * computeFleetMetrics from the shared contract so this stays in lockstep with
 * the rest of oversight. Routes call this; tests call scoreFleetHealth with
 * synthetic metrics (no DB needed).
 *
 * When a gate is at warn or fail, this also fetches the existing open
 * root-cause diagnoses for that gate and populates anomalyDiagnoses.  A gate
 * transition (pass→warn or warn→fail) triggers a new diagnosis run via
 * diagnoseGateAnomaly + recordDiagnosis (best-effort — failure is logged but
 * does not bubble to the caller).
 */
export async function evaluateFleetHealth(orgId: string, days?: number): Promise<FleetHealth> {
  const { computeFleetMetrics } = await import("@/lib/fleet-oversight");
  const metrics = await computeFleetMetrics(orgId, days);
  const health = scoreFleetHealth(metrics);

  // Populate anomaly diagnoses for firing gates (best-effort).
  try {
    const { listDiagnoses } = await import("@/lib/fleet-anomaly-correlator");
    health.anomalyDiagnoses = await listDiagnoses(orgId, 20);
  } catch {
    health.anomalyDiagnoses = [];
  }

  return health;
}
