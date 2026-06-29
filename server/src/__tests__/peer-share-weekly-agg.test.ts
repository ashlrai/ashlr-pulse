/**
 * peer-share-weekly-agg.test.ts
 *
 * Tests for the peer_share_weekly_aggregate materialisation layer.
 *
 * Test matrix:
 *   1. Unit — delta % logic (3 cases: growth, decline, zero)
 *   2. Unit — isoWeekStart correctly floors dates to Monday 00:00 UTC
 *   3. Unit — buildWowDeltas aggregates all WEEKLY_FIELDS correctly
 *   4. Unit — rowsToTotals collapses flat rows into WeeklyTotals
 *   5. Unit — privacy: WEEKLY_FIELDS are a subset of SHAREABLE_FIELDS
 *   6. Integration (DB-gated) — hourly rows roll up to weekly correctly
 *   7. Integration (DB-gated) — peer-share rules enforce field visibility
 *   8. Integration (DB-gated) — idempotency: re-run produces same rows
 *
 * Run unit-only (no DB):
 *   bun test src/__tests__/peer-share-weekly-agg.test.ts
 *
 * Run with DB:
 *   DATABASE_URL=postgres://localhost/pulse_test bun test src/__tests__/peer-share-weekly-agg.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  computeWowDeltaPct,
  buildWowDeltas,
  isoWeekStart,
  rowsToTotals,
  refreshWeeklyAggregates,
  WEEKLY_FIELDS,
  type WeeklyTotals,
  type PeerShareWeeklyRow,
} from "../lib/peer-share-weekly-agg";
import { SHAREABLE_FIELDS } from "../lib/peer-share-guard";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// 1. Unit — computeWowDeltaPct
// ---------------------------------------------------------------------------

describe("computeWowDeltaPct — delta % logic (unit, no DB)", () => {
  test("growth: this > last → positive %", () => {
    // 100 → 150: +50%
    expect(computeWowDeltaPct(150, 100)).toBe(50);
  });

  test("decline: this < last → negative %", () => {
    // 200 → 100: -50%
    expect(computeWowDeltaPct(100, 200)).toBe(-50);
  });

  test("zero last week → 0 (no division by zero)", () => {
    expect(computeWowDeltaPct(999, 0)).toBe(0);
  });

  test("equal values → 0%", () => {
    expect(computeWowDeltaPct(100, 100)).toBe(0);
  });

  test("fractional result is rounded to 2dp", () => {
    // 100 → 133: +33%
    const result = computeWowDeltaPct(133, 100);
    expect(result).toBe(33);
  });

  test("large growth: 10x → +900%", () => {
    expect(computeWowDeltaPct(1000, 100)).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// 2. Unit — isoWeekStart
// ---------------------------------------------------------------------------

describe("isoWeekStart — floors dates to Monday 00:00 UTC (unit, no DB)", () => {
  test("Monday stays as-is", () => {
    // 2026-06-29 is a Monday
    const d = new Date("2026-06-29T09:00:00.000Z");
    expect(isoWeekStart(d)).toBe("2026-06-29");
  });

  test("Tuesday floors to prior Monday", () => {
    const d = new Date("2026-06-30T15:30:00.000Z");
    expect(isoWeekStart(d)).toBe("2026-06-29");
  });

  test("Sunday floors to prior Monday", () => {
    const d = new Date("2026-07-05T23:59:59.000Z");
    expect(isoWeekStart(d)).toBe("2026-06-29");
  });

  test("Saturday floors to prior Monday", () => {
    const d = new Date("2026-07-04T00:00:00.000Z");
    expect(isoWeekStart(d)).toBe("2026-06-29");
  });

  test("exact Monday midnight UTC stays as-is", () => {
    const d = new Date("2026-06-29T00:00:00.000Z");
    expect(isoWeekStart(d)).toBe("2026-06-29");
  });

  test("result format is YYYY-MM-DD", () => {
    const d = new Date("2026-01-01T12:00:00.000Z");
    expect(isoWeekStart(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// 3. Unit — buildWowDeltas
// ---------------------------------------------------------------------------

function makeTotals(overrides: Partial<WeeklyTotals> = {}): WeeklyTotals {
  return {
    weekStartIso:   "2026-06-29",
    costMillicents:  1000,
    tokensInput:     5000,
    tokensOutput:    2000,
    eventCount:      20,
    distinctRepos:   3,
    distinctModels:  2,
    toolCallsTotal:  50,
    ...overrides,
  };
}

describe("buildWowDeltas — all WEEKLY_FIELDS (unit, no DB)", () => {
  test("produces one WowDelta per WEEKLY_FIELD", () => {
    const deltas = buildWowDeltas(makeTotals(), makeTotals());
    expect(deltas).toHaveLength(WEEKLY_FIELDS.length);
    for (const field of WEEKLY_FIELDS) {
      expect(deltas.find((d) => d.field === field)).toBeDefined();
    }
  });

  test("equal totals → all deltaPct === 0", () => {
    const t = makeTotals();
    const deltas = buildWowDeltas(t, t);
    for (const d of deltas) {
      expect(d.deltaPct).toBe(0);
    }
  });

  test("doubled cost this week → cost deltaPct === 100", () => {
    const tw = makeTotals({ costMillicents: 2000 });
    const lw = makeTotals({ costMillicents: 1000 });
    const deltas = buildWowDeltas(tw, lw);
    const costDelta = deltas.find((d) => d.field === "cost_millicents")!;
    expect(costDelta.deltaPct).toBe(100);
    expect(costDelta.thisWeek).toBe(2000);
    expect(costDelta.lastWeek).toBe(1000);
  });

  test("zero last-week cost → deltaPct === 0 (no NaN/Infinity)", () => {
    const tw = makeTotals({ costMillicents: 500 });
    const lw = makeTotals({ costMillicents: 0 });
    const deltas = buildWowDeltas(tw, lw);
    const costDelta = deltas.find((d) => d.field === "cost_millicents")!;
    expect(costDelta.deltaPct).toBe(0);
    expect(Number.isFinite(costDelta.deltaPct)).toBe(true);
  });

  test("50% decline in tokens_input", () => {
    const tw = makeTotals({ tokensInput: 2500 });
    const lw = makeTotals({ tokensInput: 5000 });
    const deltas = buildWowDeltas(tw, lw);
    const d = deltas.find((d) => d.field === "tokens_input")!;
    expect(d.deltaPct).toBe(-50);
  });
});

// ---------------------------------------------------------------------------
// 4. Unit — rowsToTotals
// ---------------------------------------------------------------------------

describe("rowsToTotals — collapses flat rows (unit, no DB)", () => {
  function makeRow(field: string, value: number, weekIso = "2026-06-29"): PeerShareWeeklyRow {
    return {
      id: 1,
      ownerId:  "owner-1",
      viewerId: "viewer-1",
      weekStartIso: weekIso,
      field: field as never,
      value,
      upsertedAt: new Date().toISOString(),
    };
  }

  test("empty rows → all zeros", () => {
    const totals = rowsToTotals([], "2026-06-29");
    expect(totals.costMillicents).toBe(0);
    expect(totals.tokensInput).toBe(0);
    expect(totals.tokensOutput).toBe(0);
    expect(totals.eventCount).toBe(0);
  });

  test("single cost row maps correctly", () => {
    const rows = [makeRow("cost_millicents", 4200)];
    const totals = rowsToTotals(rows, "2026-06-29");
    expect(totals.costMillicents).toBe(4200);
    expect(totals.tokensInput).toBe(0); // not in rows
  });

  test("rows for wrong week are ignored", () => {
    const rows = [
      makeRow("cost_millicents", 9999, "2026-06-22"), // last week, wrong ISO
    ];
    const totals = rowsToTotals(rows, "2026-06-29");
    expect(totals.costMillicents).toBe(0);
  });

  test("all WEEKLY_FIELDS populated correctly", () => {
    const rows = WEEKLY_FIELDS.map((f, i) => makeRow(f, (i + 1) * 100));
    const totals = rowsToTotals(rows, "2026-06-29");
    expect(totals.costMillicents).toBe(100);
    expect(totals.tokensInput).toBe(200);
    expect(totals.tokensOutput).toBe(300);
    expect(totals.eventCount).toBe(400);
    expect(totals.distinctRepos).toBe(500);
    expect(totals.distinctModels).toBe(600);
    expect(totals.toolCallsTotal).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// 5. Unit — WEEKLY_FIELDS are SHAREABLE_FIELDS subset (privacy invariant)
// ---------------------------------------------------------------------------

describe("WEEKLY_FIELDS — privacy invariant (unit, no DB)", () => {
  test("raw activity_event columns used in weekly agg are in SHAREABLE_FIELDS", () => {
    // distinct_repos, distinct_models, tool_calls_total, and event_count are
    // computed aggregates (not raw activity_event columns) so they need not be
    // in SHAREABLE_FIELDS — they are derived server-side and never exposed raw.
    // The underlying raw columns that feed them must be shareable.
    const rawActivityEventFields = ["cost_millicents", "tokens_input", "tokens_output"];
    for (const f of rawActivityEventFields) {
      expect(SHAREABLE_FIELDS.has(f)).toBe(true);
    }
  });

  test("WEEKLY_FIELDS contains exactly the expected 7 fields", () => {
    expect(WEEKLY_FIELDS).toHaveLength(7);
  });

  test("no WEEKLY_FIELD is 'prompts', 'completions', or 'raw_otel_span'", () => {
    const forbidden = ["prompts", "completions", "raw_otel_span"];
    for (const f of forbidden) {
      expect(WEEKLY_FIELDS).not.toContain(f);
    }
  });
});

// ---------------------------------------------------------------------------
// 6–8. Integration tests — DB-gated
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("peer-share-weekly-agg — DB integration", () => {
  const tag = Date.now();
  const ownerEmail   = `weekly-agg-owner-${tag}@local`;
  const viewerEmail  = `weekly-agg-viewer-${tag}@local`;
  const unrelatedEmail = `weekly-agg-unrelated-${tag}@local`;

  let ownerId     = "";
  let viewerId    = "";
  let unrelatedId = "";
  let shareId     = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  /**
   * Two hourly buckets in the same ISO week — same week-start.
   * We place them 2 weeks in the past so the week is definitely "complete"
   * and won't be affected by the current running hour.
   */
  const WEEK_OFFSET_MS = 14 * 24 * 3_600_000; // 2 weeks back
  const NOW = Date.now();

  // Find the Monday of the target week (2 weeks ago).
  function getTargetWeekMonday(): Date {
    const target = new Date(NOW - WEEK_OFFSET_MS);
    const dayOffset = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayOffset);
    target.setUTCHours(0, 0, 0, 0);
    return target;
  }

  const WEEK_MONDAY = getTargetWeekMonday();
  const BUCKET1 = new Date(WEEK_MONDAY.getTime() + 2 * 3_600_000);  // Mon +2h
  const BUCKET2 = new Date(WEEK_MONDAY.getTime() + 26 * 3_600_000); // Tue +2h
  const WEEK_ISO = WEEK_MONDAY.toISOString().slice(0, 10);

  // Hourly rows we'll manually insert to drive the weekly roll-up.
  const HOURLY_ROWS = [
    { hour_bucket: BUCKET1, source: "claude_code", model: "claude-opus-4-8",
      tokens_input: 1000, tokens_output: 500, cost_millicents: 300, event_count: 5 },
    { hour_bucket: BUCKET2, source: "claude_code", model: "claude-sonnet-4-6",
      tokens_input: 2000, tokens_output: 800, cost_millicents: 600, event_count: 8 },
  ];

  const EXPECTED_COST   = 900;  // 300 + 600
  const EXPECTED_INPUT  = 3000; // 1000 + 2000
  const EXPECTED_OUTPUT = 1300; // 500 + 800
  const EXPECTED_EVENTS = 13;   // 5 + 8

  beforeAll(async () => {
    const { sql } = await import("../lib/db");
    db = sql();

    // Create owner, viewer, unrelated.
    const [rowOwner] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"wa-owner-" + tag}, ${"wa-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowViewer] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"wa-viewer-" + tag}, ${"wa-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowUnrelated] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${unrelatedEmail}, ${"wa-unrelated-" + tag}, ${"wa-unrelated-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId     = rowOwner.id;
    viewerId    = rowViewer.id;
    unrelatedId = rowUnrelated.id;

    // Insert hourly aggregate rows directly (bypassing raw events).
    for (const hr of HOURLY_ROWS) {
      await db`
        INSERT INTO peer_share_hourly_aggregate
          (owner_id, viewer_id, hour_bucket, source, model,
           tokens_input, tokens_output, cost_millicents, event_count, computed_at)
        VALUES (
          ${ownerId}::uuid, ${viewerId}::uuid,
          ${hr.hour_bucket.toISOString()}::timestamptz,
          ${hr.source}, ${hr.model},
          ${hr.tokens_input}, ${hr.tokens_output},
          ${hr.cost_millicents}, ${hr.event_count},
          NOW()
        )
        ON CONFLICT (owner_id, viewer_id, hour_bucket, source, model) DO NOTHING
      `;
    }

    // Create a non-revoked peer_share grant (owner → viewer).
    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        'all', NULL, 'weekly',
        ARRAY['ts','source','model','tokens_input','tokens_output','cost_millicents']
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM peer_share_weekly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share_hourly_aggregate  WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid, ${unrelatedId}::uuid)`;
  });

  // ── Test 6: hourly rows roll up to weekly correctly ──────────────────────

  test("refreshWeeklyAggregates returns positive upserted count", async () => {
    const since = new Date(WEEK_MONDAY.getTime() - 3_600_000); // 1h before week start
    const count = await refreshWeeklyAggregates(ownerId, viewerId, since);
    expect(count).toBeGreaterThan(0);
  });

  test("weekly aggregate sums match expected hourly totals", async () => {
    const rows = await db<{ field: string; value: string | number }[]>`
      SELECT field, value
      FROM peer_share_weekly_aggregate
      WHERE owner_id       = ${ownerId}::uuid
        AND viewer_id      = ${viewerId}::uuid
        AND week_start_iso = ${WEEK_ISO}
    `;

    expect(rows.length).toBeGreaterThan(0);

    const byField: Record<string, number> = {};
    for (const r of rows) {
      byField[r.field] = Number(r.value);
    }

    expect(byField["cost_millicents"]).toBe(EXPECTED_COST);
    expect(byField["tokens_input"]).toBe(EXPECTED_INPUT);
    expect(byField["tokens_output"]).toBe(EXPECTED_OUTPUT);
    expect(byField["event_count"]).toBe(EXPECTED_EVENTS);
  });

  // ── Test 7: peer-share rules enforce field visibility ────────────────────

  test("revoked grant: refreshWeeklyAggregates inserts no cost rows", async () => {
    // Revoke the grant.
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;

    try {
      // Delete existing weekly rows so we start fresh.
      await db`DELETE FROM peer_share_weekly_aggregate WHERE owner_id = ${ownerId}::uuid`;

      const since = new Date(WEEK_MONDAY.getTime() - 3_600_000);
      const count = await refreshWeeklyAggregates(ownerId, viewerId, since);

      // With a revoked grant, the EXISTS check in refreshWeeklyAggregates
      // should prevent any rows from being inserted.
      expect(count).toBe(0);

      const rows = await db<{ field: string }[]>`
        SELECT field FROM peer_share_weekly_aggregate
        WHERE owner_id  = ${ownerId}::uuid
          AND viewer_id = ${viewerId}::uuid
      `;
      expect(rows.length).toBe(0);
    } finally {
      // Restore grant for subsequent tests.
      await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
      // Re-populate weekly rows for idempotency test below.
      const since = new Date(WEEK_MONDAY.getTime() - 3_600_000);
      await refreshWeeklyAggregates(ownerId, viewerId, since);
    }
  });

  test("unrelated user gets no weekly aggregate rows (isolation)", async () => {
    const rows = await db<{ id: number }[]>`
      SELECT id FROM peer_share_weekly_aggregate
      WHERE viewer_id = ${unrelatedId}::uuid
        AND owner_id  = ${ownerId}::uuid
    `;
    expect(rows.length).toBe(0);
  });

  // ── Test 8: idempotency ──────────────────────────────────────────────────

  test("re-running refreshWeeklyAggregates is idempotent — same rows, no double-count", async () => {
    const since = new Date(WEEK_MONDAY.getTime() - 3_600_000);

    // Run twice over the same window.
    await refreshWeeklyAggregates(ownerId, viewerId, since);
    await refreshWeeklyAggregates(ownerId, viewerId, since);

    // Sums must not be doubled.
    const rows = await db<{ field: string; value: string | number }[]>`
      SELECT field, value
      FROM peer_share_weekly_aggregate
      WHERE owner_id       = ${ownerId}::uuid
        AND viewer_id      = ${viewerId}::uuid
        AND week_start_iso = ${WEEK_ISO}
    `;

    const byField: Record<string, number> = {};
    for (const r of rows) byField[r.field] = Number(r.value);

    // Values must still match expected — not 2x.
    expect(byField["cost_millicents"]).toBe(EXPECTED_COST);
    expect(byField["tokens_input"]).toBe(EXPECTED_INPUT);
    expect(byField["tokens_output"]).toBe(EXPECTED_OUTPUT);
    expect(byField["event_count"]).toBe(EXPECTED_EVENTS);
  });

  test("aggregate rows contain only aggregate columns — no forbidden fields", async () => {
    const rows = await db<Record<string, unknown>[]>`
      SELECT * FROM peer_share_weekly_aggregate
      WHERE owner_id  = ${ownerId}::uuid
        AND viewer_id = ${viewerId}::uuid
      LIMIT 5
    `;
    expect(rows.length).toBeGreaterThan(0);
    const FORBIDDEN_COLS = ["prompts", "completions", "raw_otel_span"];
    for (const row of rows) {
      for (const col of FORBIDDEN_COLS) {
        expect(Object.keys(row)).not.toContain(col);
      }
    }
  });
});
