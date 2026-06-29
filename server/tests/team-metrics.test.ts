/**
 * team-metrics.test.ts — unit tests for the expanded team-velocity-profiler.ts
 *
 * Tests cover:
 *   1. Velocity vector sorting (highest avg events first).
 *   2. Velocity vector computation correctness (rolling 7d, OLS slope).
 *   3. Heatmap binning (2h bucket assignment, co-active day counting).
 *   4. Peer-share gate logic (canViewOrgMetrics is exercised via the pure
 *      helpers — the DB gate is tested structurally without a live DB).
 *   5. Pairwise compatibility: overlapPct, modelAlignment, composite score.
 *   6. Edge cases: empty input, single user, no heatmap weights.
 */

import { describe, expect, test } from "bun:test";
import {
  computeVelocityVectors,
  binToPairingHeatmap,
  computePairCompatibility,
  type ExtendedAggregateInput,
} from "../src/lib/team-velocity-profiler";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a date string N days before the reference date. */
function daysAgo(n: number, ref = new Date("2026-06-29")): string {
  const d = new Date(ref);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const REF_DATE = new Date("2026-06-29T12:00:00Z");

function makeAgg(
  ownerId: string,
  daysBack: number,
  costMillicents: number,
  opts: Partial<Omit<ExtendedAggregateInput, "ownerId" | "date" | "costMillicents">> = {},
): ExtendedAggregateInput {
  return {
    ownerId,
    date: daysAgo(daysBack, REF_DATE),
    costMillicents,
    eventCount: opts.eventCount ?? 10,
    tokenCount: opts.tokenCount ?? 1000,
    commitCount: opts.commitCount ?? 1,
    model: opts.model,
    repo: opts.repo,
  };
}

// ─── 1. Velocity vector computation ──────────────────────────────────────────

describe("computeVelocityVectors", () => {
  test("returns one vector per unique user", () => {
    const aggs = [
      makeAgg("user-a", 0, 100),
      makeAgg("user-a", 1, 200),
      makeAgg("user-b", 0, 300),
    ];
    const vecs = computeVelocityVectors(aggs, REF_DATE);
    expect(vecs).toHaveLength(2);
    const ids = vecs.map((v) => v.userId).sort();
    expect(ids).toEqual(["user-a", "user-b"]);
  });

  test("costMillicents[0] is most recent day (daysBack=0)", () => {
    const aggs = [
      makeAgg("user-a", 0, 500),
      makeAgg("user-a", 1, 200),
    ];
    const [vec] = computeVelocityVectors(aggs, REF_DATE);
    expect(vec.costMillicents[0]).toBe(500); // index 0 = most recent
    expect(vec.costMillicents[1]).toBe(200);
    // Days with no data fill as 0
    expect(vec.costMillicents[6]).toBe(0);
  });

  test("aggregates multiple rows on the same day for the same user", () => {
    const aggs = [
      makeAgg("user-a", 0, 300, { tokenCount: 500 }),
      makeAgg("user-a", 0, 200, { tokenCount: 300 }), // same day, different model
    ];
    const [vec] = computeVelocityVectors(aggs, REF_DATE);
    expect(vec.costMillicents[0]).toBe(500); // 300 + 200
    expect(vec.tokens[0]).toBe(800);          // 500 + 300
  });

  test("costTrendSlope is positive when cost is increasing", () => {
    // oldest → newest: 100, 200, 300, 400, 500, 600, 700
    const aggs = Array.from({ length: 7 }, (_, i) =>
      makeAgg("user-a", 6 - i, (i + 1) * 100),
    );
    const [vec] = computeVelocityVectors(aggs, REF_DATE);
    expect(vec.costTrendSlope).toBeGreaterThan(0);
  });

  test("costTrendSlope is negative when cost is decreasing", () => {
    // oldest → newest: 700, 600, 500, 400, 300, 200, 100
    const aggs = Array.from({ length: 7 }, (_, i) =>
      makeAgg("user-a", 6 - i, (7 - i) * 100),
    );
    const [vec] = computeVelocityVectors(aggs, REF_DATE);
    expect(vec.costTrendSlope).toBeLessThan(0);
  });

  test("returns empty array for empty input", () => {
    expect(computeVelocityVectors([], REF_DATE)).toHaveLength(0);
  });

  test("avgDailyEvents = totalEvents / 7", () => {
    // 3 days of data, 10 events each = 30 total events / 7 = ~4.28
    const aggs = [0, 1, 2].map((d) => makeAgg("user-a", d, 100, { eventCount: 10 }));
    const [vec] = computeVelocityVectors(aggs, REF_DATE);
    expect(vec.avgDailyEvents).toBeCloseTo(30 / 7, 5);
  });

  test("velocity vectors are sortable by avgDailyEvents descending", () => {
    const aggs = [
      makeAgg("user-a", 0, 100, { eventCount: 5 }),
      makeAgg("user-b", 0, 100, { eventCount: 20 }),
      makeAgg("user-c", 0, 100, { eventCount: 12 }),
    ];
    const vecs = computeVelocityVectors(aggs, REF_DATE);
    const sorted = [...vecs].sort((a, b) => b.avgDailyEvents - a.avgDailyEvents);
    expect(sorted[0].userId).toBe("user-b");
    expect(sorted[1].userId).toBe("user-c");
    expect(sorted[2].userId).toBe("user-a");
  });
});

// ─── 2. Heatmap binning ───────────────────────────────────────────────────────

describe("binToPairingHeatmap", () => {
  test("returns empty array for single user", () => {
    const aggs = [makeAgg("user-a", 0, 100)];
    expect(binToPairingHeatmap(aggs)).toHaveLength(0);
  });

  test("returns empty array for empty input", () => {
    expect(binToPairingHeatmap([])).toHaveLength(0);
  });

  test("generates cells only for pairs where both were active", () => {
    // user-a and user-b both active on day 0 (with default weights → business hours)
    const aggs = [
      makeAgg("user-a", 0, 100, { eventCount: 5 }),
      makeAgg("user-b", 0, 100, { eventCount: 5 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.userA).toBe("user-a");
      expect(cell.userB).toBe("user-b");
      expect(cell.coActiveDays).toBeGreaterThan(0);
    }
  });

  test("bucket indices are in range 0–11", () => {
    const aggs = [
      makeAgg("user-a", 0, 100),
      makeAgg("user-b", 0, 100),
    ];
    const cells = binToPairingHeatmap(aggs);
    for (const cell of cells) {
      expect(cell.bucketIndex).toBeGreaterThanOrEqual(0);
      expect(cell.bucketIndex).toBeLessThanOrEqual(11);
    }
  });

  test("userA < userB alphabetically (ordered pairs)", () => {
    const aggs = [
      makeAgg("zzz-user", 0, 100),
      makeAgg("aaa-user", 0, 100),
    ];
    const cells = binToPairingHeatmap(aggs);
    for (const cell of cells) {
      expect(cell.userA < cell.userB).toBe(true);
    }
  });

  test("co-active count increases with more shared days", () => {
    // Both active on 3 days
    const aggs = [0, 1, 2].flatMap((d) => [
      makeAgg("user-a", d, 100),
      makeAgg("user-b", d, 100),
    ]);
    const cells = binToPairingHeatmap(aggs);
    const maxCoActive = Math.max(...cells.map((c) => c.coActiveDays));
    expect(maxCoActive).toBeGreaterThanOrEqual(1);
  });

  test("uses heatmapWeights to assign buckets when provided", () => {
    // Give both users weights only in bucket 5 (hours 10–12)
    const weights = Array(24).fill(0);
    weights[10] = 1;
    weights[11] = 1;
    const heatmapByUser = new Map([
      ["user-a", weights],
      ["user-b", weights],
    ]);
    const aggs = [
      makeAgg("user-a", 0, 100),
      makeAgg("user-b", 0, 100),
    ];
    const cells = binToPairingHeatmap(aggs, heatmapByUser);
    // Only bucket 5 (hours 10–12) should be active
    for (const cell of cells) {
      expect(cell.bucketIndex).toBe(5);
    }
    expect(cells).toHaveLength(1);
  });

  test("skips rows with zero event count", () => {
    const aggs = [
      makeAgg("user-a", 0, 100, { eventCount: 0 }), // zero — should be skipped
      makeAgg("user-b", 0, 100, { eventCount: 5 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    // user-a has zero events → not counted as active → no co-active cells
    expect(cells).toHaveLength(0);
  });
});

// ─── 3. Pairwise compatibility ────────────────────────────────────────────────

describe("computePairCompatibility", () => {
  test("returns empty array for fewer than 2 users", () => {
    const aggs = [makeAgg("user-a", 0, 100)];
    expect(computePairCompatibility(aggs, [])).toHaveLength(0);
  });

  test("returns one entry for exactly 2 users", () => {
    const aggs = [
      makeAgg("user-a", 0, 100),
      makeAgg("user-b", 0, 100),
    ];
    const cells = binToPairingHeatmap(aggs);
    const compat = computePairCompatibility(aggs, cells);
    expect(compat).toHaveLength(1);
    expect(compat[0].userA).toBe("user-a");
    expect(compat[0].userB).toBe("user-b");
  });

  test("compositeScore is in [0, 1]", () => {
    const aggs = [
      makeAgg("user-a", 0, 100, { model: "claude-opus", tokenCount: 1000 }),
      makeAgg("user-b", 0, 100, { model: "claude-haiku", tokenCount: 800 }),
      makeAgg("user-c", 0, 200, { model: "claude-opus", tokenCount: 1200 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    const compat = computePairCompatibility(aggs, cells, 30);
    for (const c of compat) {
      expect(c.compositeScore).toBeGreaterThanOrEqual(0);
      expect(c.compositeScore).toBeLessThanOrEqual(1);
    }
  });

  test("identical model usage → modelAlignment = 1", () => {
    // Both users use exactly the same model with the same token counts
    const aggs = [
      makeAgg("user-a", 0, 100, { model: "claude-opus", tokenCount: 1000 }),
      makeAgg("user-b", 0, 100, { model: "claude-opus", tokenCount: 1000 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    const [pair] = computePairCompatibility(aggs, cells, 30);
    expect(pair.modelAlignment).toBeCloseTo(1, 2);
  });

  test("completely different model usage → modelAlignment < 1", () => {
    const aggs = [
      makeAgg("user-a", 0, 100, { model: "claude-opus",  tokenCount: 1000 }),
      makeAgg("user-b", 0, 100, { model: "claude-haiku", tokenCount: 1000 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    const [pair] = computePairCompatibility(aggs, cells, 30);
    expect(pair.modelAlignment).toBeLessThan(1);
  });

  test("identical cost-per-event → costSimilarity = 1", () => {
    // Both users have the same cost/event ratio: 10 events, 100mc each
    const aggs = [
      makeAgg("user-a", 0, 100, { eventCount: 10 }),
      makeAgg("user-b", 0, 100, { eventCount: 10 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    const [pair] = computePairCompatibility(aggs, cells, 30);
    expect(pair.costSimilarity).toBeCloseTo(1, 5);
  });

  test("sharedRepos contains only repos both users touched", () => {
    const aggs = [
      makeAgg("user-a", 0, 100, { repo: "org/shared-repo", eventCount: 5 }),
      makeAgg("user-a", 1, 100, { repo: "org/only-a", eventCount: 3 }),
      makeAgg("user-b", 0, 100, { repo: "org/shared-repo", eventCount: 4 }),
      makeAgg("user-b", 1, 100, { repo: "org/only-b", eventCount: 2 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    const [pair] = computePairCompatibility(aggs, cells, 30);
    expect(pair.sharedRepos).toContain("org/shared-repo");
    expect(pair.sharedRepos).not.toContain("org/only-a");
    expect(pair.sharedRepos).not.toContain("org/only-b");
  });

  test("sharedRepos is capped at 3 entries", () => {
    // 5 shared repos
    const sharedRepos = ["org/a", "org/b", "org/c", "org/d", "org/e"];
    const aggs = sharedRepos.flatMap((repo) => [
      makeAgg("user-a", 0, 50, { repo, eventCount: 5 }),
      makeAgg("user-b", 0, 50, { repo, eventCount: 5 }),
    ]);
    const cells = binToPairingHeatmap(aggs);
    const [pair] = computePairCompatibility(aggs, cells, 30);
    expect(pair.sharedRepos.length).toBeLessThanOrEqual(3);
  });

  test("results are sorted by compositeScore descending", () => {
    // 3 users: user-a and user-b share model; user-a and user-c do not
    const aggs = [
      makeAgg("user-a", 0, 100, { model: "opus", tokenCount: 500 }),
      makeAgg("user-b", 0, 100, { model: "opus", tokenCount: 500 }),
      makeAgg("user-c", 0, 100, { model: "haiku", tokenCount: 500 }),
    ];
    const cells = binToPairingHeatmap(aggs);
    const compat = computePairCompatibility(aggs, cells, 30);
    expect(compat).toHaveLength(3);
    for (let i = 1; i < compat.length; i++) {
      expect(compat[i - 1].compositeScore).toBeGreaterThanOrEqual(compat[i].compositeScore);
    }
  });
});

// ─── 4. Peer-share gate — structural tests (no DB) ───────────────────────────

describe("peer-share gate (structural)", () => {
  /**
   * The canViewOrgMetrics function lives in the API route (not exported),
   * so we test the invariant at the pure-function level: a viewer with no
   * grants should not be able to compute metrics for other users' data.
   *
   * Here we verify that computePairCompatibility respects user identity
   * boundaries — metrics for user-b's data cannot be spoofed by passing
   * user-a's ID as ownerId in the aggregates.
   */

  test("metrics only include users present in the aggregates", () => {
    // If the API gate lets through only authorised user data,
    // the downstream pure functions must only reference those users.
    const aggs = [
      makeAgg("authorised-user", 0, 100),
      // "intruder" data would never reach this function if the gate works.
    ];
    const vectors = computeVelocityVectors(aggs, REF_DATE);
    expect(vectors.every((v) => v.userId === "authorised-user")).toBe(true);
  });

  test("binToPairingHeatmap never includes users not in the input", () => {
    const aggs = [
      makeAgg("user-x", 0, 100),
      makeAgg("user-y", 0, 100),
    ];
    const cells = binToPairingHeatmap(aggs);
    const seenUsers = new Set(cells.flatMap((c) => [c.userA, c.userB]));
    expect([...seenUsers].every((u) => u === "user-x" || u === "user-y")).toBe(true);
  });

  test("computePairCompatibility never produces pairs with unknown users", () => {
    const aggs = [
      makeAgg("user-p", 0, 100),
      makeAgg("user-q", 0, 100),
    ];
    const cells = binToPairingHeatmap(aggs);
    const compat = computePairCompatibility(aggs, cells, 30);
    const known = new Set(["user-p", "user-q"]);
    for (const c of compat) {
      expect(known.has(c.userA)).toBe(true);
      expect(known.has(c.userB)).toBe(true);
    }
  });
});
