/**
 * peer-share-monthly-aggregate.test.ts
 *
 * Tests for the monthly materialized aggregate + OLS trend detection.
 *
 * DB-gated tests follow the pattern in peer-share-hourly-aggregate.test.ts:
 *   describe.skipIf(!HAS_DB)
 *
 * To run against a real DB:
 *   createdb pulse_test && DATABASE_URL=postgres://localhost/pulse_test \
 *     bun run migrate && \
 *     DATABASE_URL=... bun test tests/peer-share-monthly-aggregate.test.ts ; \
 *     dropdb pulse_test
 *
 * Pure unit tests (no DB) cover:
 *   1.  truncateToMonthUTC rounds to month start.
 *   2.  subtractMonths handles year wrap-around.
 *   3.  computeTrendFlag returns null for < 2 prior months.
 *   4.  computeTrendFlag returns 'stable' for flat series.
 *   5.  computeTrendFlag returns 'trending_up' for upward series.
 *   6.  computeTrendFlag returns 'trending_down' for downward series.
 *   7.  computeTrendFlag returns 'anomaly' when current month spikes > 2σ.
 *   8.  computeTrendFlag: anomaly takes priority over directional trend.
 *   9.  buildMonthlyEvents filters zero-cost rows.
 *   10. buildMonthlyEvents maps fields correctly.
 *
 * DB integration tests cover:
 *   11. refreshMonthlyAggregates inserts a row for the current month.
 *   12. Cost and event totals match seeded activity_event rows.
 *   13. Upsert is idempotent — re-running does not double-count.
 *   14. readMonthlyRows returns rows within the requested bucket range.
 *   15. PRIVACY: revoked grant produces no non-zero aggregate rows.
 *   16. PRIVACY: stranger (no grant) sees no rows.
 *   17. pruneMonthlyAggregates removes rows older than MONTHLY_RETENTION_MONTHS.
 *   18. runMonthlyAggregateCron processes active pairs and skips revoked grants.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  truncateToMonthUTC,
  subtractMonths,
  computeTrendFlag,
  buildMonthlyEvents,
  refreshMonthlyAggregates,
  readMonthlyRows,
  pruneMonthlyAggregates,
  runMonthlyAggregateCron,
  MONTHLY_RETENTION_MONTHS,
  type PeerShareMonthlyAggregate,
} from "../src/lib/peer-share-monthly-aggregate";
import { sql } from "../src/lib/db";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure unit tests — no DB required
// ---------------------------------------------------------------------------

describe("truncateToMonthUTC (unit)", () => {
  test("returns first moment of the UTC month", () => {
    const d = new Date("2026-06-15T14:30:00.000Z");
    const truncated = truncateToMonthUTC(d);
    expect(truncated.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  test("already-truncated date is unchanged", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(truncateToMonthUTC(d).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("handles end-of-month correctly", () => {
    const d = new Date("2026-01-31T23:59:59.999Z");
    expect(truncateToMonthUTC(d).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("subtractMonths (unit)", () => {
  test("subtracts months within the same year", () => {
    const d = new Date("2026-06-15T10:00:00.000Z");
    const result = subtractMonths(d, 2);
    expect(result.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  test("wraps across year boundary", () => {
    const d = new Date("2026-02-10T00:00:00.000Z");
    const result = subtractMonths(d, 3);
    expect(result.toISOString()).toBe("2025-11-01T00:00:00.000Z");
  });

  test("0 months returns current month start", () => {
    const d = new Date("2026-06-20T12:00:00.000Z");
    const result = subtractMonths(d, 0);
    expect(result.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("computeTrendFlag (unit)", () => {
  test("returns null when fewer than 2 prior months", () => {
    expect(computeTrendFlag([], 5000)).toBeNull();
    expect(computeTrendFlag([3000], 5000)).toBeNull();
  });

  test("returns 'stable' for a flat cost series", () => {
    // All three prior months identical — slope ≈ 0, well within 5% threshold.
    const prior = [10_000, 10_000, 10_000];
    const flag = computeTrendFlag(prior, 10_000);
    expect(flag).toBe("stable");
  });

  test("returns 'trending_up' for steadily rising costs", () => {
    // prior=[1000,2000,3000,4000,5000]: mean=3000, σ≈1414, slope=1000 >> threshold(150)
    // current=5500: z=(5500-3000)/1414≈1.77 — safely below anomaly threshold of 2.
    const prior = [1_000, 2_000, 3_000, 4_000, 5_000];
    const flag = computeTrendFlag(prior, 5_500);
    expect(flag).toBe("trending_up");
  });

  test("returns 'trending_down' for steadily falling costs", () => {
    // prior=[5000,4000,3000,2000,1000]: mean=3000, σ≈1414, slope=-1000 >> threshold(150)
    // current=500: z=(500-3000)/1414≈-1.77 — within 2σ, not anomaly.
    const prior = [5_000, 4_000, 3_000, 2_000, 1_000];
    const flag = computeTrendFlag(prior, 500);
    expect(flag).toBe("trending_down");
  });

  test("returns 'anomaly' when current month spikes > 2σ above prior mean", () => {
    // Prior months all ~1000; current month is 50 000 (huge spike).
    const prior = [1_000, 1_050, 980];
    const flag = computeTrendFlag(prior, 50_000);
    expect(flag).toBe("anomaly");
  });

  test("anomaly takes priority over trending_up", () => {
    // Even if the series is trending up, a massive spike should be 'anomaly'.
    const prior = [1_000, 2_000, 3_000];
    // Current month is 1_000_000 — clearly anomalous even on a rising series.
    const flag = computeTrendFlag(prior, 1_000_000);
    expect(flag).toBe("anomaly");
  });

  test("returns 'stable' when prior months have tiny variation", () => {
    // ±1% variation — should not exceed 5% threshold.
    const prior = [10_000, 10_100, 9_900];
    const flag = computeTrendFlag(prior, 10_050);
    expect(flag).toBe("stable");
  });
});

describe("buildMonthlyEvents (unit)", () => {
  const makeRow = (overrides: Partial<PeerShareMonthlyAggregate>): PeerShareMonthlyAggregate => ({
    id: 1,
    ownerId: "owner-1",
    viewerId: "viewer-1",
    monthBucket: "2026-06-01T00:00:00.000Z",
    source: "ashlr",
    model: "claude-sonnet-4-5",
    tokensInput: 0,
    tokensOutput: 0,
    costMillicents: 0,
    eventCount: 0,
    trendFlag: null,
    computedAt: new Date().toISOString(),
    ...overrides,
  });

  test("filters out zero-cost zero-event sentinel rows", () => {
    const rows = [makeRow({ costMillicents: 0, eventCount: 0 })];
    const events = buildMonthlyEvents(rows);
    expect(events).toHaveLength(0);
  });

  test("includes rows with non-zero cost", () => {
    const rows = [makeRow({ costMillicents: 5_000, eventCount: 3 })];
    const events = buildMonthlyEvents(rows);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("monthly");
    expect(events[0].costMillicents).toBe(5_000);
    expect(events[0].eventCount).toBe(3);
  });

  test("includes rows with non-zero event count even if cost is zero", () => {
    const rows = [makeRow({ costMillicents: 0, eventCount: 1 })];
    const events = buildMonthlyEvents(rows);
    expect(events).toHaveLength(1);
  });

  test("maps all fields correctly", () => {
    const rows = [makeRow({
      ownerId: "o-1",
      monthBucket: "2026-05-01T00:00:00.000Z",
      source: "cursor",
      model: "gpt-4o",
      tokensInput: 100,
      tokensOutput: 200,
      costMillicents: 1_500,
      eventCount: 7,
      trendFlag: "trending_up",
    })];
    const [ev] = buildMonthlyEvents(rows);
    expect(ev.ownerId).toBe("o-1");
    expect(ev.bucket).toBe("2026-05-01T00:00:00.000Z");
    expect(ev.source).toBe("cursor");
    expect(ev.model).toBe("gpt-4o");
    expect(ev.tokensInput).toBe(100);
    expect(ev.tokensOutput).toBe(200);
    expect(ev.trendFlag).toBe("trending_up");
  });

  test("preserves null trendFlag", () => {
    const rows = [makeRow({ costMillicents: 100, trendFlag: null })];
    const [ev] = buildMonthlyEvents(rows);
    expect(ev.trendFlag).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB integration tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("peer_share_monthly_aggregate DB", () => {
  const tag = Date.now();
  const ownerEmail   = `pulse-pma-owner-${tag}@local`;
  const viewerEmail  = `pulse-pma-viewer-${tag}@local`;
  const strangerEmail = `pulse-pma-stranger-${tag}@local`;

  let ownerId   = "";
  let viewerId  = "";
  let strangerId = "";
  let shareId   = "";

  // Use the start of the current UTC month.
  const now = new Date();
  const currentMonthStart = truncateToMonthUTC(now);

  const COST_A = 4_000; // millicents
  const COST_B = 6_500;
  const TOTAL_COST = COST_A + COST_B;

  let db: ReturnType<typeof sql>;

  beforeAll(async () => {
    db = sql();

    const [ownerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"pma-owner-" + tag}, ${"pma-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId = ownerRow.id;

    const [viewerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"pma-viewer-" + tag}, ${"pma-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    viewerId = viewerRow.id;

    const [strangerRow] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${strangerEmail}, ${"pma-stranger-" + tag}, ${"pma-stranger-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    strangerId = strangerRow.id;

    // Active grant from owner → viewer
    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        'all', NULL, 'realtime',
        ARRAY['ts','source','model','tokens_input','tokens_output','cost_millicents']
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;

    // Seed activity_event rows for the owner inside the current calendar month.
    // Place them 2 minutes after month start so they land in currentMonthStart bucket.
    const eventTs = new Date(currentMonthStart.getTime() + 2 * 60_000).toISOString();
    await db`
      INSERT INTO activity_event
        (user_id, source, model, tokens_input, tokens_output, cost_millicents, ts)
      VALUES
        (${ownerId}::uuid, 'ashlr', 'claude-sonnet-4-5', 200, 400, ${COST_A}, ${eventTs}::timestamptz),
        (${ownerId}::uuid, 'ashlr', 'claude-haiku-4-5',  100, 200, ${COST_B}, ${eventTs}::timestamptz)
    `;
  });

  afterAll(async () => {
    await db`DELETE FROM peer_share_monthly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid, ${strangerId}::uuid)`;
  });

  // -------------------------------------------------------------------------
  // Test 11: basic insert
  // -------------------------------------------------------------------------
  test("refreshMonthlyAggregates inserts a row for the current month", async () => {
    const count = await refreshMonthlyAggregates(ownerId, viewerId);
    expect(count).toBeGreaterThan(0);

    const rows = await db<{ cost_millicents: number; event_count: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS cost_millicents,
        SUM(event_count)::int        AS event_count
      FROM peer_share_monthly_aggregate
      WHERE owner_id    = ${ownerId}::uuid
        AND viewer_id   = ${viewerId}::uuid
        AND month_bucket = ${currentMonthStart.toISOString()}::timestamptz
    `;
    expect(rows.length).toBeGreaterThan(0);
    const agg = rows[0];
    expect(agg).toBeDefined();
    // Cost rollup must match raw sum within 1 millicent.
    expect(Math.abs(Number(agg.cost_millicents) - TOTAL_COST)).toBeLessThanOrEqual(1);
    // Event count must match seeded rows (2 events).
    expect(Number(agg.event_count)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 12: idempotency
  // -------------------------------------------------------------------------
  test("upsert is idempotent — re-running does not double-count", async () => {
    await refreshMonthlyAggregates(ownerId, viewerId);
    await refreshMonthlyAggregates(ownerId, viewerId);

    const rows = await db<{ cost_millicents: number; event_count: number }[]>`
      SELECT
        SUM(cost_millicents)::bigint AS cost_millicents,
        SUM(event_count)::int        AS event_count
      FROM peer_share_monthly_aggregate
      WHERE owner_id    = ${ownerId}::uuid
        AND viewer_id   = ${viewerId}::uuid
        AND month_bucket = ${currentMonthStart.toISOString()}::timestamptz
    `;
    const agg = rows[0];
    expect(Math.abs(Number(agg.cost_millicents) - TOTAL_COST)).toBeLessThanOrEqual(1);
    expect(Number(agg.event_count)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 13: readMonthlyRows range filter
  // -------------------------------------------------------------------------
  test("readMonthlyRows returns rows within the requested bucket range", async () => {
    const fromMonth = subtractMonths(now, 1); // prev month
    const toMonth = truncateToMonthUTC(now);  // current month

    const rows = await readMonthlyRows(ownerId, viewerId, fromMonth, toMonth);
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const ts = new Date(r.monthBucket).getTime();
      expect(ts).toBeGreaterThanOrEqual(fromMonth.getTime());
      expect(ts).toBeLessThanOrEqual(toMonth.getTime());
    }
  });

  // -------------------------------------------------------------------------
  // Test 14: PRIVACY — revoked grant produces no non-zero rows
  // -------------------------------------------------------------------------
  test("PRIVACY: revoked grant — refreshMonthlyAggregates writes no cost rows", async () => {
    // Revoke temporarily.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;

    // Delete existing rows for this pair.
    await db`DELETE FROM peer_share_monthly_aggregate WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid`;

    await refreshMonthlyAggregates(ownerId, viewerId);

    const rows = await db<{ total_cost: number; total_events: number }[]>`
      SELECT
        COALESCE(SUM(cost_millicents), 0)::bigint AS total_cost,
        COALESCE(SUM(event_count), 0)::int        AS total_events
      FROM peer_share_monthly_aggregate
      WHERE owner_id    = ${ownerId}::uuid
        AND viewer_id   = ${viewerId}::uuid
        AND month_bucket = ${currentMonthStart.toISOString()}::timestamptz
    `;
    expect(Number(rows[0]?.total_cost   ?? 0)).toBe(0);
    expect(Number(rows[0]?.total_events ?? 0)).toBe(0);

    // Restore.
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
  });

  // -------------------------------------------------------------------------
  // Test 15: PRIVACY — stranger (no grant) sees no rows
  // -------------------------------------------------------------------------
  test("PRIVACY: stranger with no grant cannot see owner rows", async () => {
    await refreshMonthlyAggregates(ownerId, strangerId);

    const fromMonth = subtractMonths(now, 0);
    const toMonth   = truncateToMonthUTC(now);
    const rows = await readMonthlyRows(ownerId, strangerId, fromMonth, toMonth);

    const nonZero = rows.filter((r) => r.costMillicents > 0 || r.eventCount > 0);
    expect(nonZero).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 16: pruneMonthlyAggregates removes stale rows
  // -------------------------------------------------------------------------
  test("pruneMonthlyAggregates removes rows older than MONTHLY_RETENTION_MONTHS", async () => {
    // Insert a row that is MONTHLY_RETENTION_MONTHS + 1 months old.
    const oldMonth = subtractMonths(now, MONTHLY_RETENTION_MONTHS + 1);
    const oldMonthIso = oldMonth.toISOString();

    await db`
      INSERT INTO peer_share_monthly_aggregate
        (owner_id, viewer_id, month_bucket, source, model,
         tokens_input, tokens_output, cost_millicents, event_count,
         trend_flag, computed_at)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        ${oldMonthIso}::timestamptz, 'ashlr', 'claude-sonnet-4-5',
        0, 0, 0, 0, NULL, NOW()
      )
      ON CONFLICT (owner_id, viewer_id, month_bucket, source, model) DO UPDATE SET computed_at = NOW()
    `;

    const pruned = await pruneMonthlyAggregates();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const check = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_monthly_aggregate
      WHERE owner_id   = ${ownerId}::uuid
        AND viewer_id  = ${viewerId}::uuid
        AND month_bucket = ${oldMonthIso}::timestamptz
    `;
    expect(Number(check[0]?.n ?? 0)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 17: runMonthlyAggregateCron processes active pairs + skips revoked
  // -------------------------------------------------------------------------
  test("runMonthlyAggregateCron processes active pairs and skips revoked grants", async () => {
    // Clean slate for deterministic counts.
    await db`DELETE FROM peer_share_monthly_aggregate WHERE owner_id = ${ownerId}::uuid`;

    const result = await runMonthlyAggregateCron();
    expect(result.pairs).toBeGreaterThanOrEqual(1);
    expect(result.rowsUpserted).toBeGreaterThan(0);
    expect(typeof result.rowsPruned).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);

    // Now revoke the grant and verify the pair produces no cost rows.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;
    await db`DELETE FROM peer_share_monthly_aggregate WHERE owner_id = ${ownerId}::uuid AND viewer_id = ${viewerId}::uuid`;

    await runMonthlyAggregateCron();

    const rows = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM peer_share_monthly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
        AND (cost_millicents > 0 OR event_count > 0)
    `;
    expect(Number(rows[0]?.n ?? 0)).toBe(0);

    // Restore for afterAll cleanup.
    await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
  });

  // -------------------------------------------------------------------------
  // Test 18: trend_flag is written and is a valid value
  // -------------------------------------------------------------------------
  test("trend_flag on upserted rows is null or a valid enum value", async () => {
    await db`DELETE FROM peer_share_monthly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await refreshMonthlyAggregates(ownerId, viewerId);

    const rows = await db<{ trend_flag: string | null }[]>`
      SELECT trend_flag
      FROM peer_share_monthly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
    `;
    const validFlags = new Set([null, "trending_up", "trending_down", "stable", "anomaly"]);
    for (const r of rows) {
      expect(validFlags.has(r.trend_flag)).toBe(true);
    }
  });
});
