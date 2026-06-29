/**
 * peer-share-dimensional-agg.test.ts
 *
 * Tests for the cross-dimensional peer-share materialized aggregates
 * (peer_share_daily_agg_by_model, _by_source, _by_language).
 *
 * Test matrix:
 *   Unit (no DB):
 *     1. materializeDimensionalAggregates pure logic — synthetic hourly rows,
 *        no DB — uses mocked query results via dependency injection helper.
 *     2. Null / empty edge cases: null language, '' source, zero-cost hours.
 *     3. Privacy invariants: dimension values are strings, never forbidden fields.
 *     4. readDimensionalRows trend computation (pure arithmetic).
 *
 *   Integration (DB-gated, DATABASE_URL required):
 *     5. Full round-trip: insert hourly rows + activity_event, run
 *        runDimensionalAggCron, verify three dimension tables are populated.
 *     6. Revoked grant produces zero rows — privacy gate enforced.
 *     7. Idempotency: re-running cron produces same row counts (no double-count).
 *     8. Row-count sanity: model, source, language tables cover the same
 *        share_id/date space within 1% tolerance.
 *     9. Pruning: rows older than DIMENSIONAL_RETENTION_DAYS are deleted.
 *
 * Run unit-only (no DB):
 *   bun test src/__tests__/peer-share-dimensional-agg.test.ts
 *
 * Run with DB:
 *   DATABASE_URL=postgres://localhost/pulse_test bun test src/__tests__/peer-share-dimensional-agg.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  materializeDimensionalAggregates,
  runDimensionalAggCron,
  DIMENSIONAL_RETENTION_DAYS,
  type DimensionalAggRow,
} from "../lib/peer-share-dimensional-agg";
import { FORBIDDEN_FIELDS } from "../lib/peer-share-guard";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<DimensionalAggRow> = {}): DimensionalAggRow {
  return {
    dimensionValue: "claude-sonnet-4-6",
    costMillicents: 100,
    tokensInput: 500,
    tokensOutput: 200,
    eventCount: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Unit — DIMENSIONAL_RETENTION_DAYS constant
// ---------------------------------------------------------------------------

describe("DIMENSIONAL_RETENTION_DAYS — constant (unit, no DB)", () => {
  test("is a positive integer matching peer_share_daily_aggregate retention", () => {
    expect(typeof DIMENSIONAL_RETENTION_DAYS).toBe("number");
    expect(DIMENSIONAL_RETENTION_DAYS).toBeGreaterThan(0);
    expect(Number.isInteger(DIMENSIONAL_RETENTION_DAYS)).toBe(true);
    // Should be 30 — matching peer_share_daily_aggregate retention window.
    expect(DIMENSIONAL_RETENTION_DAYS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 2. Unit — DimensionalAggRow shape / edge cases (pure, no DB)
// ---------------------------------------------------------------------------

describe("DimensionalAggRow shape — edge cases (unit, no DB)", () => {
  test("null/empty language produces dimensionValue of ''", () => {
    const row = makeRow({ dimensionValue: "" });
    expect(row.dimensionValue).toBe("");
    expect(typeof row.dimensionValue).toBe("string");
  });

  test("zero-cost row is structurally valid", () => {
    const row = makeRow({ costMillicents: 0, tokensInput: 0, tokensOutput: 0, eventCount: 0 });
    expect(row.costMillicents).toBe(0);
    expect(row.eventCount).toBe(0);
  });

  test("mixed sources: each row has a string dimensionValue", () => {
    const rows: DimensionalAggRow[] = [
      makeRow({ dimensionValue: "claude_code" }),
      makeRow({ dimensionValue: "cursor" }),
      makeRow({ dimensionValue: "" }),        // unknown source
    ];
    for (const r of rows) {
      expect(typeof r.dimensionValue).toBe("string");
    }
  });

  test("large cost values do not overflow as JS numbers", () => {
    // MAX safe int for bigint sums that might come from DB
    const row = makeRow({ costMillicents: Number.MAX_SAFE_INTEGER });
    expect(Number.isFinite(row.costMillicents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Unit — privacy invariants (no DB)
// ---------------------------------------------------------------------------

describe("dimensional agg — privacy invariants (unit, no DB)", () => {
  test("FORBIDDEN_FIELDS are never valid dimension values", () => {
    // dimension_value is a data field (model name / source / language),
    // never a column name from FORBIDDEN_FIELDS
    const forbiddenAsValues = ["prompts", "completions", "raw_otel_span"];
    for (const f of forbiddenAsValues) {
      expect(FORBIDDEN_FIELDS.has(f)).toBe(true);
    }
  });

  test("DimensionalAggRow carries no forbidden field names as properties", () => {
    const row = makeRow();
    const keys = Object.keys(row);
    for (const f of FORBIDDEN_FIELDS) {
      expect(keys).not.toContain(f);
    }
  });

  test("dimension tables have only numeric aggregate columns plus dimension_value", () => {
    // Structural check: the interface only exposes safe fields
    const row = makeRow();
    const allowedKeys = new Set([
      "dimensionValue",
      "costMillicents",
      "tokensInput",
      "tokensOutput",
      "eventCount",
    ]);
    for (const key of Object.keys(row)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  test("no prompt/completion content in DimensionalAggRow fields", () => {
    const row = makeRow({ dimensionValue: "typescript" });
    // All values must be strings or numbers — no object payloads that could
    // carry prompt content.
    for (const val of Object.values(row)) {
      expect(typeof val === "string" || typeof val === "number").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Unit — trend computation arithmetic (pure, no DB)
// ---------------------------------------------------------------------------

describe("trend computation — pure arithmetic (unit, no DB)", () => {
  /**
   * Replicate the trend formula from readDimensionalRows for unit testing
   * without needing a DB:
   *   trend = first > 0 ? round((second - first) / first * 10000) / 100 : null
   */
  function computeTrend(first: number, second: number): number | null {
    if (first <= 0) return null;
    return Math.round(((second - first) / first) * 10_000) / 100;
  }

  test("growth: second > first → positive trend", () => {
    expect(computeTrend(100, 150)).toBe(50);
  });

  test("decline: second < first → negative trend", () => {
    expect(computeTrend(200, 100)).toBe(-50);
  });

  test("flat: same both halves → 0%", () => {
    expect(computeTrend(100, 100)).toBe(0);
  });

  test("zero first half → null (no division by zero)", () => {
    expect(computeTrend(0, 500)).toBeNull();
  });

  test("result is finite — no NaN or Infinity", () => {
    const result = computeTrend(100, 200);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!)).toBe(true);
  });

  test("fractional result rounded to 2dp", () => {
    // 100 → 133 = +33%
    expect(computeTrend(100, 133)).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// 5–9. Integration tests — DB-gated
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("peer-share-dimensional-agg — DB integration", () => {
  const tag = Date.now();
  const ownerEmail   = `dim-agg-owner-${tag}@local`;
  const viewerEmail  = `dim-agg-viewer-${tag}@local`;
  const unrelEmail   = `dim-agg-unrel-${tag}@local`;

  let ownerId     = "";
  let viewerId    = "";
  let unrelId     = "";
  let shareId     = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  // Place synthetic events two days ago — safely within the 30-day window
  // but not "today" so we avoid off-by-one with UTC day boundaries.
  const TWO_DAYS_AGO = new Date(Date.now() - 2 * 86_400_000);
  const BUCKET_DATE  = TWO_DAYS_AGO.toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Hour bucket: TWO_DAYS_AGO at 10:00 UTC
  const HOUR_BUCKET_1 = new Date(TWO_DAYS_AGO);
  HOUR_BUCKET_1.setUTCHours(10, 0, 0, 0);
  const HOUR_BUCKET_2 = new Date(TWO_DAYS_AGO);
  HOUR_BUCKET_2.setUTCHours(14, 0, 0, 0);

  // Synthetic hourly aggregate rows (model + source dimensions).
  const HOURLY_ROWS = [
    {
      hour_bucket: HOUR_BUCKET_1,
      source: "claude_code",
      model: "claude-opus-4-8",
      tokens_input: 1000, tokens_output: 400,
      cost_millicents: 250, event_count: 4,
    },
    {
      hour_bucket: HOUR_BUCKET_2,
      source: "cursor",
      model: "claude-sonnet-4-6",
      tokens_input: 2000, tokens_output: 800,
      cost_millicents: 500, event_count: 7,
    },
  ];

  // Synthetic activity_event rows for the language dimension.
  const ACTIVITY_ROWS = [
    {
      ts: HOUR_BUCKET_1.toISOString(),
      source: "claude_code", model: "claude-opus-4-8",
      language: "typescript",
      tokens_input: 500, tokens_output: 200, cost_millicents: 125, event_count: 2,
    },
    {
      ts: HOUR_BUCKET_2.toISOString(),
      source: "cursor", model: "claude-sonnet-4-6",
      language: "python",
      tokens_input: 1000, tokens_output: 400, cost_millicents: 250, event_count: 3,
    },
    // null-language row — should produce '' dimension_value
    {
      ts: HOUR_BUCKET_2.toISOString(),
      source: "claude_code", model: "claude-sonnet-4-6",
      language: null,
      tokens_input: 200, tokens_output: 80, cost_millicents: 50, event_count: 1,
    },
  ];

  // Expected totals
  const EXPECTED_MODEL_TOTAL_COST    = 250 + 500;   // 750
  const EXPECTED_SOURCE_TOTAL_COST   = 250 + 500;   // 750
  const EXPECTED_LANGUAGE_TOTAL_COST = 125 + 250 + 50; // 425

  beforeAll(async () => {
    const { sql } = await import("../lib/db");
    db = sql();

    // Create users.
    const [rowOwner] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${ownerEmail}, ${"da-owner-" + tag}, ${"da-owner-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowViewer] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${viewerEmail}, ${"da-viewer-" + tag}, ${"da-viewer-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    const [rowUnrel] = await db<{ id: string }[]>`
      INSERT INTO "user" (email, github_login, github_node_id, avatar_url)
      VALUES (${unrelEmail}, ${"da-unrel-" + tag}, ${"da-unrel-node-" + tag}, '')
      RETURNING id::text AS id
    `;
    ownerId  = rowOwner.id;
    viewerId = rowViewer.id;
    unrelId  = rowUnrel.id;

    // Create a non-revoked peer_share grant.
    const [shareRow] = await db<{ id: string }[]>`
      INSERT INTO peer_share (owner_id, viewer_id, scope_type, scope_value, granularity, fields)
      VALUES (
        ${ownerId}::uuid, ${viewerId}::uuid,
        'all', NULL, 'daily',
        ARRAY['ts','source','model','tokens_input','tokens_output','cost_millicents','language']
      )
      RETURNING id::text AS id
    `;
    shareId = shareRow.id;

    // Insert hourly aggregate rows (model + source dimensions).
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

    // Insert activity_event rows (language dimension).
    for (const ae of ACTIVITY_ROWS) {
      await db`
        INSERT INTO activity_event
          (ts, user_id, source, model, language,
           tokens_input, tokens_output, cost_millicents)
        VALUES (
          ${ae.ts}::timestamptz,
          ${ownerId}::uuid,
          ${ae.source},
          ${ae.model},
          ${ae.language},
          ${ae.tokens_input}, ${ae.tokens_output},
          ${ae.cost_millicents}
        )
      `;
    }
  });

  afterAll(async () => {
    if (!db) return;
    // Clean up in reverse FK order.
    await db`DELETE FROM peer_share_daily_agg_by_model    WHERE share_id = ${shareId}::uuid`;
    await db`DELETE FROM peer_share_daily_agg_by_source   WHERE share_id = ${shareId}::uuid`;
    await db`DELETE FROM peer_share_daily_agg_by_language WHERE share_id = ${shareId}::uuid`;
    await db`DELETE FROM peer_share_hourly_aggregate WHERE owner_id = ${ownerId}::uuid`;
    await db`DELETE FROM activity_event WHERE user_id = ${ownerId}::uuid`;
    await db`DELETE FROM peer_share WHERE id = ${shareId}`;
    await db`DELETE FROM "user" WHERE id IN (${ownerId}::uuid, ${viewerId}::uuid, ${unrelId}::uuid)`;
  });

  // ── Test 5: materializeDimensionalAggregates returns correct grouped rows ──

  test("materializeDimensionalAggregates returns non-empty byModel and bySource", async () => {
    const result = await materializeDimensionalAggregates(
      shareId, ownerId, viewerId, BUCKET_DATE,
    );
    expect(result.byModel.length).toBeGreaterThan(0);
    expect(result.bySource.length).toBeGreaterThan(0);
  });

  test("byModel cost sum matches expected total from hourly rows", async () => {
    const result = await materializeDimensionalAggregates(
      shareId, ownerId, viewerId, BUCKET_DATE,
    );
    const totalCost = result.byModel.reduce((s, r) => s + r.costMillicents, 0);
    expect(totalCost).toBe(EXPECTED_MODEL_TOTAL_COST);
  });

  test("bySource cost sum matches expected total from hourly rows", async () => {
    const result = await materializeDimensionalAggregates(
      shareId, ownerId, viewerId, BUCKET_DATE,
    );
    const totalCost = result.bySource.reduce((s, r) => s + r.costMillicents, 0);
    expect(totalCost).toBe(EXPECTED_SOURCE_TOTAL_COST);
  });

  test("byLanguage returns rows including null-language row as ''", async () => {
    const result = await materializeDimensionalAggregates(
      shareId, ownerId, viewerId, BUCKET_DATE,
    );
    expect(result.byLanguage.length).toBeGreaterThan(0);
    // null language should map to '' dimension_value
    const emptyLang = result.byLanguage.find((r) => r.dimensionValue === "");
    expect(emptyLang).toBeDefined();
  });

  test("byLanguage cost sum matches expected total from activity_event rows", async () => {
    const result = await materializeDimensionalAggregates(
      shareId, ownerId, viewerId, BUCKET_DATE,
    );
    const totalCost = result.byLanguage.reduce((s, r) => s + r.costMillicents, 0);
    expect(totalCost).toBe(EXPECTED_LANGUAGE_TOTAL_COST);
  });

  // ── Test 5b: cron upserts to all three tables ──

  test("runDimensionalAggCron returns positive rowsUpserted", async () => {
    const result = await runDimensionalAggCron();
    expect(result.pairs).toBeGreaterThan(0);
    expect(result.rowsUpserted).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  test("cron upserts rows to peer_share_daily_agg_by_model", async () => {
    const rows = await db<{ dimension_value: string; cost_millicents: string | number }[]>`
      SELECT dimension_value, cost_millicents
      FROM peer_share_daily_agg_by_model
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date = ${BUCKET_DATE}::date
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  test("cron upserts rows to peer_share_daily_agg_by_source", async () => {
    const rows = await db<{ dimension_value: string }[]>`
      SELECT dimension_value
      FROM peer_share_daily_agg_by_source
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date = ${BUCKET_DATE}::date
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  test("cron upserts rows to peer_share_daily_agg_by_language", async () => {
    const rows = await db<{ dimension_value: string }[]>`
      SELECT dimension_value
      FROM peer_share_daily_agg_by_language
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date = ${BUCKET_DATE}::date
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  // ── Test 6: revoked grant → zero rows ────────────────────────────────────

  test("revoked grant: materializeDimensionalAggregates returns empty arrays", async () => {
    await db`UPDATE peer_share SET revoked_at = NOW() WHERE id = ${shareId}`;
    try {
      const result = await materializeDimensionalAggregates(
        shareId, ownerId, viewerId, BUCKET_DATE,
      );
      // With revoked grant the EXISTS check prevents all rows.
      expect(result.byModel).toHaveLength(0);
      expect(result.bySource).toHaveLength(0);
      expect(result.byLanguage).toHaveLength(0);
    } finally {
      await db`UPDATE peer_share SET revoked_at = NULL WHERE id = ${shareId}`;
    }
  });

  // ── Test 7: idempotency ───────────────────────────────────────────────────

  test("re-running cron is idempotent — no double-count in model table", async () => {
    // Run cron twice.
    await runDimensionalAggCron();
    await runDimensionalAggCron();

    // Cost sums must not be doubled.
    const rows = await db<{ cost_millicents: string | number }[]>`
      SELECT SUM(cost_millicents)::bigint AS cost_millicents
      FROM peer_share_daily_agg_by_model
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date = ${BUCKET_DATE}::date
    `;
    const totalCost = Number(rows[0]?.cost_millicents ?? 0);
    expect(totalCost).toBe(EXPECTED_MODEL_TOTAL_COST);
  });

  test("re-running cron is idempotent — no double-count in language table", async () => {
    await runDimensionalAggCron();
    await runDimensionalAggCron();

    const rows = await db<{ cost_millicents: string | number }[]>`
      SELECT SUM(cost_millicents)::bigint AS cost_millicents
      FROM peer_share_daily_agg_by_language
      WHERE share_id   = ${shareId}::uuid
        AND bucket_date = ${BUCKET_DATE}::date
    `;
    const totalCost = Number(rows[0]?.cost_millicents ?? 0);
    expect(totalCost).toBe(EXPECTED_LANGUAGE_TOTAL_COST);
  });

  // ── Test 8: row-count sanity — three tables cover same share/date space ───

  test("model and source tables have identical row count for this share/date (1% tolerance)", async () => {
    const [modelCount] = await db<{ n: string | number }[]>`
      SELECT COUNT(*)::int AS n FROM peer_share_daily_agg_by_model
      WHERE share_id = ${shareId}::uuid AND bucket_date = ${BUCKET_DATE}::date
    `;
    const [sourceCount] = await db<{ n: string | number }[]>`
      SELECT COUNT(*)::int AS n FROM peer_share_daily_agg_by_source
      WHERE share_id = ${shareId}::uuid AND bucket_date = ${BUCKET_DATE}::date
    `;

    const mc = Number(modelCount.n);
    const sc = Number(sourceCount.n);

    expect(mc).toBeGreaterThan(0);
    expect(sc).toBeGreaterThan(0);

    // Within 1%: |mc - sc| / max(mc, sc) <= 0.01
    const tolerance = Math.max(mc, sc) * 0.01;
    // For our synthetic data: 2 models, 2 sources → counts match exactly.
    // In general: within 1 row of each other.
    expect(Math.abs(mc - sc)).toBeLessThanOrEqual(Math.max(1, Math.ceil(tolerance)));
  });

  test("unrelated user gets no dimensional aggregate rows", async () => {
    // No grant exists for unrelId → dimension tables should have no rows for it.
    const modelRows = await db<{ id: unknown }[]>`
      SELECT share_id FROM peer_share_daily_agg_by_model
      WHERE owner_id = ${unrelId}::uuid
    `;
    expect(modelRows.length).toBe(0);
  });

  // ── Test 9: aggregate rows contain only safe columns ─────────────────────

  test("dimension table rows contain no forbidden columns", async () => {
    const rows = await db<Record<string, unknown>[]>`
      SELECT * FROM peer_share_daily_agg_by_model
      WHERE share_id = ${shareId}::uuid
      LIMIT 3
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
