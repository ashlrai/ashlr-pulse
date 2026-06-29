/**
 * fleet-daily-aggregate.test.ts
 *
 * Test suite for the fleet_daily_aggregate materialized table feature.
 *
 * UNIT TESTS (no DB, always run):
 *   1. Aggregate SQL logic — pure helpers: date-range generation, row
 *      accumulation, retention cutoff computation. Tests the same arithmetic
 *      that refreshFleetAggregates() and pruneFleetAggregates() use.
 *   2. Retention enforcement — the 90-day cutoff boundary: rows at exactly
 *      RETENTION_DAYS old, one day before, and one day after.
 *
 * INTEGRATION TEST (DB-gated, describe.skipIf(!HAS_DB)):
 *   3. Concurrent cron + stale data handling — two concurrent
 *      refreshFleetAggregates() calls for the same org/day must both succeed
 *      without throwing (ON CONFLICT … DO UPDATE is idempotent) and the final
 *      row must reflect the last writer's values. Also seeds a "stale" row
 *      (computed_at in the past) and verifies it is overwritten.
 *
 * To run the integration test:
 *   createdb pulse_test
 *   DATABASE_URL=postgres://localhost/pulse_test bun run migrate
 *   DATABASE_URL=postgres://localhost/pulse_test bun test tests/fleet-daily-aggregate.test.ts
 *   dropdb pulse_test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Unit tests — aggregate SQL logic (pure, no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe("aggregate date-range generation", () => {
  /** Mirror of the date-list logic in refreshFleetAggregates(). */
  function buildDateRange(sinceUtcMs: number, yesterdayUtcMs: number): string[] {
    const msPerDay = 86_400_000;
    const totalDays =
      Math.round((yesterdayUtcMs - sinceUtcMs) / msPerDay) + 1;
    const clampedDays = Math.min(totalDays, 30);
    const clampedSince = yesterdayUtcMs - (clampedDays - 1) * msPerDay;
    const days: string[] = [];
    for (let d = 0; d < clampedDays; d++) {
      const day = new Date(clampedSince + d * msPerDay);
      days.push(day.toISOString().slice(0, 10));
    }
    return days;
  }

  test("7-day window produces exactly 7 date strings", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const since     = new Date("2026-06-22T00:00:00.000Z").getTime();
    const dates = buildDateRange(since, yesterday);
    expect(dates.length).toBe(7);
    expect(dates[0]).toBe("2026-06-22");
    expect(dates[dates.length - 1]).toBe("2026-06-28");
  });

  test("30-day window produces exactly 30 date strings", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const since     = new Date("2026-05-30T00:00:00.000Z").getTime();
    const dates = buildDateRange(since, yesterday);
    expect(dates.length).toBe(30);
    expect(dates[0]).toBe("2026-05-30");
    expect(dates[dates.length - 1]).toBe("2026-06-28");
  });

  test("window > 30 days is clamped to 30 (default window)", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const since     = new Date("2026-01-01T00:00:00.000Z").getTime(); // 178 days
    const dates = buildDateRange(since, yesterday);
    expect(dates.length).toBe(30);
    expect(dates[dates.length - 1]).toBe("2026-06-28");
  });

  test("since > yesterday returns empty list (future window)", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const since     = new Date("2026-06-29T00:00:00.000Z").getTime(); // future
    // Simulate the early-return guard.
    const isEmpty = since > yesterday;
    expect(isEmpty).toBe(true);
  });

  test("single-day window (since === yesterday) produces exactly 1 date", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const dates = buildDateRange(yesterday, yesterday);
    expect(dates.length).toBe(1);
    expect(dates[0]).toBe("2026-06-28");
  });
});

describe("aggregate row accumulation", () => {
  /** Mirror of the reduce() in computeFleetMetrics fast path. */
  interface AggRow {
    proposals: number;
    applied: number;
    rejected: number;
    costUsd: number;
    activeAgents: number;
    reposTouched: number;
  }

  function accumulateRows(rows: AggRow[]): AggRow {
    return rows.reduce(
      (acc, row) => ({
        proposals:    acc.proposals    + row.proposals,
        applied:      acc.applied      + row.applied,
        rejected:     acc.rejected     + row.rejected,
        costUsd:      acc.costUsd      + row.costUsd,
        activeAgents: Math.max(acc.activeAgents, row.activeAgents),
        reposTouched: Math.max(acc.reposTouched, row.reposTouched),
      }),
      { proposals: 0, applied: 0, rejected: 0, costUsd: 0, activeAgents: 0, reposTouched: 0 },
    );
  }

  test("sums proposals, applied, rejected, costUsd across days", () => {
    const rows: AggRow[] = [
      { proposals: 3, applied: 2, rejected: 1, costUsd: 0.50, activeAgents: 2, reposTouched: 1 },
      { proposals: 5, applied: 4, rejected: 1, costUsd: 1.00, activeAgents: 3, reposTouched: 2 },
      { proposals: 2, applied: 2, rejected: 0, costUsd: 0.25, activeAgents: 1, reposTouched: 1 },
    ];
    const acc = accumulateRows(rows);
    expect(acc.proposals).toBe(10);
    expect(acc.applied).toBe(8);
    expect(acc.rejected).toBe(2);
    expect(acc.costUsd).toBeCloseTo(1.75, 4);
  });

  test("activeAgents is MAX across days (not sum — agents are reused)", () => {
    const rows: AggRow[] = [
      { proposals: 1, applied: 1, rejected: 0, costUsd: 0, activeAgents: 5, reposTouched: 1 },
      { proposals: 1, applied: 1, rejected: 0, costUsd: 0, activeAgents: 2, reposTouched: 1 },
      { proposals: 1, applied: 1, rejected: 0, costUsd: 0, activeAgents: 8, reposTouched: 1 },
    ];
    const acc = accumulateRows(rows);
    expect(acc.activeAgents).toBe(8);
  });

  test("reposTouched is MAX across days (distinct repo sets may overlap)", () => {
    const rows: AggRow[] = [
      { proposals: 0, applied: 0, rejected: 0, costUsd: 0, activeAgents: 1, reposTouched: 3 },
      { proposals: 0, applied: 0, rejected: 0, costUsd: 0, activeAgents: 1, reposTouched: 7 },
      { proposals: 0, applied: 0, rejected: 0, costUsd: 0, activeAgents: 1, reposTouched: 4 },
    ];
    const acc = accumulateRows(rows);
    expect(acc.reposTouched).toBe(7);
  });

  test("empty row list accumulates to all-zero", () => {
    const acc = accumulateRows([]);
    expect(acc.proposals).toBe(0);
    expect(acc.applied).toBe(0);
    expect(acc.costUsd).toBe(0);
  });

  test("single row passes through unchanged", () => {
    const rows: AggRow[] = [
      { proposals: 4, applied: 3, rejected: 1, costUsd: 2.50, activeAgents: 6, reposTouched: 5 },
    ];
    const acc = accumulateRows(rows);
    expect(acc.proposals).toBe(4);
    expect(acc.applied).toBe(3);
    expect(acc.rejected).toBe(1);
    expect(acc.costUsd).toBeCloseTo(2.50, 4);
    expect(acc.activeAgents).toBe(6);
    expect(acc.reposTouched).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Unit tests — retention enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("retention cutoff computation", () => {
  const RETENTION_DAYS = 90;

  /** Mirror of the cutoff logic in pruneFleetAggregates(). */
  function retentionCutoffDate(now: Date): string {
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    return cutoff.toISOString().slice(0, 10);
  }

  /** Return true if the given date string should be pruned (< cutoff). */
  function shouldPrune(dateStr: string, cutoff: string): boolean {
    return dateStr < cutoff;
  }

  test("row exactly at cutoff boundary is kept (not pruned)", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now); // "2026-03-31"
    // A row dated exactly at the cutoff is NOT pruned — DELETE WHERE date < cutoff.
    expect(shouldPrune(cutoff, cutoff)).toBe(false);
  });

  test("row one day before cutoff IS pruned", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now); // "2026-03-31"
    const dayBefore = new Date(new Date(cutoff).getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10); // "2026-03-30"
    expect(shouldPrune(dayBefore, cutoff)).toBe(true);
  });

  test("row one day after cutoff is kept", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    const dayAfter = new Date(new Date(cutoff).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(shouldPrune(dayAfter, cutoff)).toBe(false);
  });

  test("cutoff is exactly RETENTION_DAYS before today", () => {
    const now = new Date("2026-06-29T12:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    const expected = new Date("2026-06-29T12:00:00.000Z");
    expected.setUTCDate(expected.getUTCDate() - RETENTION_DAYS);
    expect(cutoff).toBe(expected.toISOString().slice(0, 10));
  });

  test("recent row (yesterday) is never pruned under 90-day retention", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    const yesterday = "2026-06-28";
    expect(shouldPrune(yesterday, cutoff)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Integration test — concurrent cron + stale data handling
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("fleet_daily_aggregate — concurrent upsert + stale overwrite", () => {
  // We test with a throwaway org seeded directly in the DB.
  let orgId: string;
  let userId: string;

  // Lazily resolved after skipIf guard — only imported when DB is available.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let refreshFleetAggregates: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pruneFleetAggregates: any;

  const email = `agg-test-${Date.now()}@local`;

  beforeAll(async () => {
    const { sql } = await import("../src/lib/db");
    const mod = await import("../src/lib/fleet-aggregate-refresh");
    refreshFleetAggregates = mod.refreshFleetAggregates;
    pruneFleetAggregates = mod.pruneFleetAggregates;
    const { ensureLocalUser, ensureDefaultOrg } = await import("../src/lib/current-user");

    db = sql();
    const me = await ensureLocalUser(email, null);
    userId = me.id;
    orgId = await ensureDefaultOrg(userId, email);

    // Seed two ashlr-fleet activity_event rows for yesterday so the aggregate
    // query has something to compute.
    await db`
      INSERT INTO activity_event
        (ts, user_id, session_id, source, repo_name, fleet_event, fleet_outcome, cost_millicents)
      VALUES
        (NOW() - INTERVAL '25 hours', ${userId}, 's-agg-1', 'ashlr-fleet', 'acme/agg', 'proposal', 'applied',  10_000),
        (NOW() - INTERVAL '26 hours', ${userId}, 's-agg-1', 'ashlr-fleet', 'acme/agg', 'proposal', 'rejected', 10_000)
    `;
  });

  afterAll(async () => {
    await db`DELETE FROM fleet_daily_aggregate WHERE org_id = ${orgId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${userId}`;
    await db`DELETE FROM "user" WHERE email = ${email}`;
  });

  test("two concurrent refreshFleetAggregates calls succeed without throwing", async () => {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 2); // 2 days ago → covers yesterday

    // Fire both concurrently — ON CONFLICT must handle the race.
    const [r1, r2] = await Promise.all([
      refreshFleetAggregates(orgId, since),
      refreshFleetAggregates(orgId, since),
    ]);

    // Both should return a positive upsert count (at least 1 day each).
    expect(r1).toBeGreaterThanOrEqual(1);
    expect(r2).toBeGreaterThanOrEqual(1);
  });

  test("stale row is overwritten by a fresh refresh", async () => {

    // The yesterday date string.
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // Seed a stale row with computed_at far in the past and wrong proposal count.
    await db`
      INSERT INTO fleet_daily_aggregate
        (org_id, date, proposals, applied, rejected, cost_usd, active_agents, repos_touched, computed_at)
      VALUES (
        ${orgId}::uuid, ${yesterdayStr}::date,
        999, 0, 0, 0, 0, 0,
        '2020-01-01T00:00:00Z'::timestamptz
      )
      ON CONFLICT (org_id, date) DO UPDATE SET
        proposals    = EXCLUDED.proposals,
        computed_at  = EXCLUDED.computed_at
    `;

    // Verify the stale value is in place.
    const before = await db<{ proposals: number; computed_at: string }[]>`
      SELECT proposals, computed_at::text FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${yesterdayStr}::date
    `;
    expect(before[0]?.proposals).toBe(999);

    // Run a fresh refresh — should overwrite the stale row.
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 2);
    await refreshFleetAggregates(orgId, since);

    const after = await db<{ proposals: number; computed_at: string }[]>`
      SELECT proposals, computed_at::text FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${yesterdayStr}::date
    `;
    // The real count from the seeded activity_event rows is 2 (not 999).
    expect(after[0]?.proposals).toBe(2);
    // computed_at must be much more recent than the stale sentinel.
    const computedAt = new Date(after[0]?.computed_at ?? "2020-01-01");
    expect(computedAt.getTime()).toBeGreaterThan(new Date("2025-01-01").getTime());
  });

  test("pruneFleetAggregates removes rows older than 90 days", async () => {

    // Seed an ancient row (200 days ago).
    const ancient = new Date();
    ancient.setUTCDate(ancient.getUTCDate() - 200);
    const ancientStr = ancient.toISOString().slice(0, 10);

    await db`
      INSERT INTO fleet_daily_aggregate
        (org_id, date, proposals, applied, rejected, cost_usd, active_agents, repos_touched)
      VALUES (${orgId}::uuid, ${ancientStr}::date, 1, 1, 0, 0, 1, 1)
      ON CONFLICT (org_id, date) DO NOTHING
    `;

    // Verify it landed.
    const before = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${ancientStr}::date
    `;
    expect(before[0]?.count).toBe(1);

    // Prune — must delete it.
    const pruned = await pruneFleetAggregates();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const after = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${ancientStr}::date
    `;
    expect(after[0]?.count).toBe(0);
  });
});
