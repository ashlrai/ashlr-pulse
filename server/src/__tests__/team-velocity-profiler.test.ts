/**
 * team-velocity-profiler.test.ts
 *
 * Unit tests for the pure profileTeamVelocity() function.
 * No DB required — runs in the bun test runner without DATABASE_URL.
 *
 * Coverage:
 *   1. Overlap detection: user A active at UTC 14 + user B active at UTC 14
 *      → overlap found at hour 14.
 *   2. Timezone scenario: user coding at 2pm PST (UTC 22) + user coding at
 *      11am EST (UTC 16) → no overlap at 14, but overlaps are found at the
 *      respective UTC hours when the two users' windows coincide.
 *   3. High-productivity zone detection via 90th-percentile threshold.
 *   4. Recommendation logic: solo user, no overlap, overlap present.
 *   5. Edge cases: empty input, single user, no data.
 */

import { describe, expect, test } from "bun:test";
import {
  profileTeamVelocity,
  type AggregateInput,
} from "../lib/team-velocity-profiler";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a heatmap weights array with activity concentrated at one hour. */
function heatmapAtHour(hour: number, weight = 1): number[] {
  const w = Array(24).fill(0);
  w[hour] = weight;
  return w;
}

/** Build a synthetic daily aggregate for a user with constant daily spend. */
function dailyAggs(
  userId: string,
  days: number,
  costPerDay = 1000,
  eventsPerDay = 10,
): AggregateInput[] {
  const aggs: AggregateInput[] = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const date = new Date(now.getTime() - d * 86_400_000);
    aggs.push({
      ownerId: userId,
      date: date.toISOString().slice(0, 10),
      costMillicents: costPerDay,
      eventCount: eventsPerDay,
    });
  }
  return aggs;
}

// ─── 1. Basic overlap detection ───────────────────────────────────────────────

describe("profileTeamVelocity — basic overlap detection", () => {
  test("finds overlap when both users are active at the same UTC hour", () => {
    const SHARED_HOUR = 14; // 2pm UTC

    const aggA = dailyAggs("user-a", 30);
    const aggB = dailyAggs("user-b", 30);
    const aggs = [...aggA, ...aggB];

    // Both users concentrated at hour 14.
    const heatmaps = new Map([
      ["user-a", heatmapAtHour(SHARED_HOUR, 10)],
      ["user-b", heatmapAtHour(SHARED_HOUR, 10)],
    ]);

    const result = profileTeamVelocity(aggs, 30, heatmaps);

    expect(result.overlaps.length).toBeGreaterThan(0);
    const overlapHours = result.overlaps.map((o) => o.hour);
    expect(overlapHours).toContain(SHARED_HOUR);
  });

  test("overlap probability is between 0 and 1", () => {
    const aggs = [...dailyAggs("user-a", 30), ...dailyAggs("user-b", 30)];
    const heatmaps = new Map([
      ["user-a", heatmapAtHour(10, 10)],
      ["user-b", heatmapAtHour(10, 10)],
    ]);
    const result = profileTeamVelocity(aggs, 30, heatmaps);
    for (const o of result.overlaps) {
      expect(o.prob).toBeGreaterThanOrEqual(0);
      expect(o.prob).toBeLessThanOrEqual(1);
    }
  });

  test("no overlap when users work at entirely different hours", () => {
    const aggs = [...dailyAggs("user-a", 30), ...dailyAggs("user-b", 30)];
    const heatmaps = new Map([
      ["user-a", heatmapAtHour(2, 10)],   // 2am UTC
      ["user-b", heatmapAtHour(14, 10)],  // 2pm UTC — 12h apart
    ]);
    const result = profileTeamVelocity(aggs, 30, heatmaps);

    // Hour 2 should not be in overlaps (user-b has zero weight there).
    const overlapHours = result.overlaps.map((o) => o.hour);
    expect(overlapHours).not.toContain(2);
    expect(overlapHours).not.toContain(14);
  });
});

// ─── 2. Timezone scenario ─────────────────────────────────────────────────────

describe("profileTeamVelocity — timezone scenario", () => {
  test("user coding at 2pm PST (UTC 22) + 11am EST (UTC 16): overlap found at UTC 16 when both active there", () => {
    // PST = UTC-8 → 2pm PST = UTC 22
    // EST = UTC-5 → 11am EST = UTC 16
    // They overlap only if both are active at the SAME UTC hour.
    // Here they are NOT at the same hour (22 ≠ 16) — no overlap expected.
    const aggs = [...dailyAggs("pst-user", 30), ...dailyAggs("est-user", 30)];
    const heatmaps = new Map([
      ["pst-user", heatmapAtHour(22, 10)],  // 2pm PST = UTC 22
      ["est-user", heatmapAtHour(16, 10)],  // 11am EST = UTC 16
    ]);
    const result = profileTeamVelocity(aggs, 30, heatmaps);
    const overlapHours = result.overlaps.map((o) => o.hour);

    // No shared UTC hour → no overlap.
    expect(overlapHours).not.toContain(22);
    expect(overlapHours).not.toContain(16);
  });

  test("user at 11am PST (UTC 19) + 2pm EST (UTC 19): overlap found at UTC 19", () => {
    // 11am PST = UTC-8 → UTC 19
    // 2pm EST  = UTC-5 → UTC 19
    // Same UTC hour → overlap should be detected.
    const OVERLAP_HOUR = 19;
    const aggs = [...dailyAggs("pst-user", 30), ...dailyAggs("est-user", 30)];
    const heatmaps = new Map([
      ["pst-user", heatmapAtHour(OVERLAP_HOUR, 10)],
      ["est-user", heatmapAtHour(OVERLAP_HOUR, 10)],
    ]);
    const result = profileTeamVelocity(aggs, 30, heatmaps);
    const overlapHours = result.overlaps.map((o) => o.hour);

    expect(overlapHours).toContain(OVERLAP_HOUR);
  });
});

// ─── 3. High-productivity zone detection ─────────────────────────────────────

describe("profileTeamVelocity — high-productivity zones", () => {
  test("marks hours above 90th percentile as high-productivity", () => {
    const aggs = [...dailyAggs("user-a", 30, 10_000), ...dailyAggs("user-b", 30, 10_000)];

    // user-a very active at hour 10, user-b at hour 10 — spike there.
    const heatWeights = Array(24).fill(1); // baseline across all hours
    heatWeights[10] = 100;                 // huge spike at 10am UTC
    const heatmaps = new Map([
      ["user-a", heatWeights],
      ["user-b", heatWeights],
    ]);

    const result = profileTeamVelocity(aggs, 30, heatmaps);

    // Hour 10 should be in the high-productivity zone.
    const highProdZones = result.zones.filter((z) => z.isHighProductivity);
    const highProdHours = highProdZones.map((z) => z.hour);
    expect(highProdHours).toContain(10);
  });

  test("returns 24 zone entries (one per hour)", () => {
    const aggs = dailyAggs("user-a", 30);
    const result = profileTeamVelocity(aggs, 30);
    expect(result.zones).toHaveLength(24);
  });

  test("all zone costPerHour values are non-negative", () => {
    const aggs = [...dailyAggs("user-a", 30), ...dailyAggs("user-b", 30)];
    const result = profileTeamVelocity(aggs, 30);
    for (const z of result.zones) {
      expect(z.costPerHour).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── 4. Recommendation logic ──────────────────────────────────────────────────

describe("profileTeamVelocity — recommendation", () => {
  test("solo user recommendation mentions adding team members", () => {
    const aggs = dailyAggs("solo-user", 30);
    const result = profileTeamVelocity(aggs, 30);
    expect(result.recommendation.toLowerCase()).toMatch(/team member|more member|add/);
  });

  test("multi-user with overlap produces non-empty recommendation", () => {
    const aggs = [...dailyAggs("user-a", 30), ...dailyAggs("user-b", 30)];
    const heatmaps = new Map([
      ["user-a", heatmapAtHour(10, 10)],
      ["user-b", heatmapAtHour(10, 10)],
    ]);
    const result = profileTeamVelocity(aggs, 30, heatmaps);
    expect(result.recommendation.length).toBeGreaterThan(10);
  });

  test("multi-user no overlap recommendation mentions async or no overlap", () => {
    const aggs = [...dailyAggs("user-a", 30), ...dailyAggs("user-b", 30)];
    const heatmaps = new Map([
      ["user-a", heatmapAtHour(1, 10)],
      ["user-b", heatmapAtHour(13, 10)],
    ]);
    const result = profileTeamVelocity(aggs, 30, heatmaps);
    // Either no overlap found or recommendation mentions async/overlap/timezone.
    if (result.overlaps.length === 0) {
      expect(result.recommendation.toLowerCase()).toMatch(/overlap|async|timezone/);
    }
  });

  test("highProductivityWindow is a non-empty string", () => {
    const aggs = [...dailyAggs("user-a", 30), ...dailyAggs("user-b", 30)];
    const result = profileTeamVelocity(aggs, 30);
    expect(typeof result.highProductivityWindow).toBe("string");
    expect(result.highProductivityWindow.length).toBeGreaterThan(0);
  });
});

// ─── 5. Edge cases ────────────────────────────────────────────────────────────

describe("profileTeamVelocity — edge cases", () => {
  test("empty aggregate array returns safe defaults", () => {
    const result = profileTeamVelocity([], 30);
    expect(result.userProfiles).toHaveLength(0);
    expect(result.overlaps).toHaveLength(0);
    expect(result.zones).toHaveLength(24);
    expect(typeof result.recommendation).toBe("string");
  });

  test("single user: no overlaps, 24 zones, recommendation for adding members", () => {
    const result = profileTeamVelocity(dailyAggs("only-user", 30), 30);
    expect(result.overlaps).toHaveLength(0);
    expect(result.zones).toHaveLength(24);
    expect(result.recommendation).toContain("team member");
  });

  test("window clamping: aggregates outside windowDays are excluded", () => {
    // All data is 60 days old, window is 30 days → should be excluded.
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const staleAggs: AggregateInput[] = [
      { ownerId: "user-a", date: oldDate, costMillicents: 5000, eventCount: 10 },
      { ownerId: "user-b", date: oldDate, costMillicents: 5000, eventCount: 10 },
    ];
    const result = profileTeamVelocity(staleAggs, 30);
    // With no data in window, profiles have zero cost.
    for (const p of result.userProfiles) {
      expect(p.totalCostMillicents).toBe(0);
    }
  });

  test("userProfiles has one entry per unique ownerId", () => {
    const aggs = [
      ...dailyAggs("user-a", 5),
      ...dailyAggs("user-b", 5),
      ...dailyAggs("user-c", 5),
    ];
    const result = profileTeamVelocity(aggs, 30);
    expect(result.userProfiles).toHaveLength(3);
    const ids = result.userProfiles.map((p) => p.userId);
    expect(ids).toContain("user-a");
    expect(ids).toContain("user-b");
    expect(ids).toContain("user-c");
  });
});
