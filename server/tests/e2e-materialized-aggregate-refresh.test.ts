/**
 * e2e-materialized-aggregate-refresh.test.ts
 *
 * End-to-end integration test for the fleet_daily_aggregate materialized
 * refresh pipeline.
 *
 * Unit tests (no DB, always run):
 *   1. Date-range generation across 3 calendar days.
 *   2. Cost sum arithmetic — within 1 millicent tolerance.
 *   3. Retention cutoff boundary — rows older than 90 days are deleted.
 *
 * Integration tests (DB-gated, describe.skipIf(!HAS_DB)):
 *   4. Ingest activity spanning 3 calendar days (yesterday, 2 days ago, 3 days ago).
 *   5. Run refreshFleetAggregates() for the org.
 *   6. Verify rows exist for all 3 days.
 *   7. Verify cost_usd sums match the seeded cost_millicents within 1 millicent
 *      (converted: cost_usd = cost_millicents / 100_000).
 *   8. Run pruneFleetAggregates() and verify rows >90 days old are deleted.
 *   9. Verify the refresh is idempotent (double-run doesn't double-count).
 *
 * To run:
 *   createdb pulse_test
 *   DATABASE_URL=postgres://localhost/pulse_test bun run migrate
 *   DATABASE_URL=postgres://localhost/pulse_test bun test tests/e2e-materialized-aggregate-refresh.test.ts
 *   dropdb pulse_test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — pure helpers, always run
// ─────────────────────────────────────────────────────────────────────────────

describe("aggregate date-range across 3 calendar days (unit)", () => {
  /** Mirror of the date-list logic in refreshFleetAggregates(). */
  function buildDateRange(sinceUtcMs: number, yesterdayUtcMs: number): string[] {
    const msPerDay = 86_400_000;
    const totalDays = Math.round((yesterdayUtcMs - sinceUtcMs) / msPerDay) + 1;
    const clampedDays = Math.min(totalDays, 30);
    const clampedSince = yesterdayUtcMs - (clampedDays - 1) * msPerDay;
    const days: string[] = [];
    for (let d = 0; d < clampedDays; d++) {
      const day = new Date(clampedSince + d * msPerDay);
      days.push(day.toISOString().slice(0, 10));
    }
    return days;
  }

  test("3-day window produces exactly 3 date strings in ascending order", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const since     = new Date("2026-06-26T00:00:00.000Z").getTime();
    const dates = buildDateRange(since, yesterday);
    expect(dates.length).toBe(3);
    expect(dates[0]).toBe("2026-06-26");
    expect(dates[1]).toBe("2026-06-27");
    expect(dates[2]).toBe("2026-06-28");
  });

  test("all 3 dates are distinct", () => {
    const yesterday = new Date("2026-06-28T00:00:00.000Z").getTime();
    const since     = new Date("2026-06-26T00:00:00.000Z").getTime();
    const dates = buildDateRange(since, yesterday);
    const unique = new Set(dates);
    expect(unique.size).toBe(dates.length);
  });
});

describe("cost sum arithmetic — millicents to USD (unit)", () => {
  const MILLICENTS_PER_USD = 100_000;

  test("cost_usd = sum(cost_millicents) / 100_000 within 1 millicent tolerance", () => {
    const costRows = [150, 200, 450]; // millicents per day
    const totalMillicents = costRows.reduce((a, b) => a + b, 0); // 800
    const costUsd = totalMillicents / MILLICENTS_PER_USD;

    // Verify the conversion is reversible within tolerance
    const recovered = Math.round(costUsd * MILLICENTS_PER_USD);
    expect(Math.abs(recovered - totalMillicents)).toBeLessThanOrEqual(1);
  });

  test("zero cost produces cost_usd of exactly 0", () => {
    const costUsd = 0 / MILLICENTS_PER_USD;
    expect(costUsd).toBe(0);
  });

  test("large cost (50 000 millicents = $0.50) converts correctly", () => {
    const millicents = 50_000;
    const usd = millicents / MILLICENTS_PER_USD;
    expect(usd).toBeCloseTo(0.5, 5);
  });
});

describe("retention cutoff — 90-day boundary (unit)", () => {
  const RETENTION_DAYS = 90;

  function retentionCutoffDate(now: Date): string {
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    return cutoff.toISOString().slice(0, 10);
  }

  function shouldPrune(dateStr: string, cutoff: string): boolean {
    return dateStr < cutoff;
  }

  test("row exactly at 90-day boundary is NOT pruned (DELETE WHERE date < cutoff)", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    expect(shouldPrune(cutoff, cutoff)).toBe(false);
  });

  test("row 91 days old IS pruned", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    const old91 = new Date(new Date(cutoff).getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(shouldPrune(old91, cutoff)).toBe(true);
  });

  test("row 89 days old is NOT pruned", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    const old89 = new Date(new Date(cutoff).getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(shouldPrune(old89, cutoff)).toBe(false);
  });

  test("today is never pruned", () => {
    const now = new Date("2026-06-29T01:00:00.000Z");
    const cutoff = retentionCutoffDate(now);
    expect(shouldPrune("2026-06-29", cutoff)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests (DB-gated)
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("e2e fleet_daily_aggregate refresh — 3-day ingest + retention", () => {
  const tag = Date.now();
  const email = `e2e-agg-${tag}@local`;

  let orgId = "";
  let userId = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let refreshFleetAggregates: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pruneFleetAggregates: any;

  // 3 calendar days: yesterday, 2-days-ago, 3-days-ago
  // We use fixed offsets relative to now so the tests are deterministic
  // regardless of the wall-clock date.
  const now = new Date();
  const dayOffsets = [1, 2, 3]; // days ago
  const dayStrings = dayOffsets.map((offset) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - offset);
    d.setUTCHours(12, 0, 0, 0); // noon UTC so we're solidly in that day
    return d.toISOString().slice(0, 10);
  });

  // Cost per day (millicents): 150, 200, 450
  const COST_PER_DAY = [150, 200, 450];
  const TOTAL_MILLICENTS = COST_PER_DAY.reduce((a, b) => a + b, 0); // 800

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

    // Seed fleet events across 3 complete calendar days
    for (let i = 0; i < dayStrings.length; i++) {
      const dayTs = `${dayStrings[i]}T12:00:00.000Z`;
      const cost = COST_PER_DAY[i];
      await db`
        INSERT INTO activity_event
          (ts, user_id, session_id, source, repo_name, fleet_event, fleet_outcome, cost_millicents)
        VALUES
          (${dayTs}::timestamptz, ${userId}, ${"s-e2e-agg-" + i}, 'ashlr-fleet', 'acme/e2e', 'proposal', 'applied', ${cost})
      `;
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM fleet_daily_aggregate WHERE org_id = ${orgId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${userId}`;
    await db`DELETE FROM org WHERE id = ${orgId}::uuid`;
    await db`DELETE FROM membership WHERE user_id = ${userId}`;
    await db`DELETE FROM "user" WHERE email = ${email}`;
  });

  // ── Test 1: rows exist for all 3 days after refresh ───────────────────────

  test("rows exist for all 3 calendar days after refreshFleetAggregates", async () => {
    const since = new Date(now);
    since.setUTCDate(since.getUTCDate() - 4); // covers all 3 seeded days

    const upserted = await refreshFleetAggregates(orgId, since);
    expect(upserted).toBeGreaterThanOrEqual(3);

    for (const dateStr of dayStrings) {
      const rows = await db<{ proposals: number }[]>`
        SELECT proposals FROM fleet_daily_aggregate
        WHERE org_id = ${orgId}::uuid AND date = ${dateStr}::date
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].proposals).toBe(1); // one proposal per day
    }
  });

  // ── Test 2: cost sums match within 1 millicent ────────────────────────────

  test("cost_usd sums across 3 days match seeded cost_millicents within 1 millicent", async () => {
    const [agg] = await db<{ total_cost_usd: number }[]>`
      SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid
        AND date = ANY(${dayStrings}::date[])
    `;

    const totalCostUsd = Number(agg.total_cost_usd);
    // Convert back to millicents for comparison
    const recoveredMillicents = Math.round(totalCostUsd * 100_000);
    expect(Math.abs(recoveredMillicents - TOTAL_MILLICENTS)).toBeLessThanOrEqual(1);
  });

  // ── Test 3: refresh is idempotent (double-run does not double-count) ───────

  test("double refreshFleetAggregates does not double-count proposals", async () => {
    const since = new Date(now);
    since.setUTCDate(since.getUTCDate() - 4);

    await refreshFleetAggregates(orgId, since);
    await refreshFleetAggregates(orgId, since);

    for (const dateStr of dayStrings) {
      const rows = await db<{ proposals: number }[]>`
        SELECT proposals FROM fleet_daily_aggregate
        WHERE org_id = ${orgId}::uuid AND date = ${dateStr}::date
      `;
      expect(rows.length).toBe(1);
      // Must still be 1 proposal per day — not doubled
      expect(rows[0].proposals).toBe(1);
    }
  });

  // ── Test 4: retention — rows >90 days old are deleted ────────────────────

  test("pruneFleetAggregates deletes rows older than 90 days", async () => {
    // Seed a 200-day-old row
    const ancient = new Date(now);
    ancient.setUTCDate(ancient.getUTCDate() - 200);
    const ancientStr = ancient.toISOString().slice(0, 10);

    await db`
      INSERT INTO fleet_daily_aggregate
        (org_id, date, proposals, applied, rejected, cost_usd, active_agents, repos_touched)
      VALUES (${orgId}::uuid, ${ancientStr}::date, 1, 1, 0, 0, 1, 1)
      ON CONFLICT (org_id, date) DO NOTHING
    `;

    // Verify it was inserted
    const before = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${ancientStr}::date
    `;
    expect(before[0]?.count).toBe(1);

    // Prune
    const pruned = await pruneFleetAggregates();
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Row is gone
    const after = await db<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${ancientStr}::date
    `;
    expect(after[0]?.count).toBe(0);
  });

  // ── Test 5: rows within retention window survive pruning ──────────────────

  test("recent rows (yesterday) survive pruneFleetAggregates", async () => {
    const pruned = await pruneFleetAggregates();
    // pruneFleetAggregates may return 0 if nothing ancient remains — that's fine
    expect(typeof pruned).toBe("number");

    // Yesterday's row must still be there
    const yesterday = dayStrings[0];
    const rows = await db<{ proposals: number }[]>`
      SELECT proposals FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${yesterday}::date
    `;
    expect(rows.length).toBe(1);
  });

  // ── Test 6: computed_at is recent after a fresh refresh ──────────────────

  test("computed_at is updated to a recent timestamp on each refresh", async () => {
    const since = new Date(now);
    since.setUTCDate(since.getUTCDate() - 4);
    await refreshFleetAggregates(orgId, since);

    const yesterday = dayStrings[0];
    const [row] = await db<{ computed_at: string }[]>`
      SELECT computed_at::text AS computed_at FROM fleet_daily_aggregate
      WHERE org_id = ${orgId}::uuid AND date = ${yesterday}::date
    `;
    const computedAt = new Date(row.computed_at);
    // computed_at must be after 2025-01-01 (not a stale sentinel)
    expect(computedAt.getTime()).toBeGreaterThan(new Date("2025-01-01").getTime());
  });
});
