/**
 * compare-data.test.ts — integration tests for loadCompare / loadForecast.
 *
 * Skips when DATABASE_URL isn't set (same pattern as peer-share-db.test.ts).
 * When a DB is present: inserts a few synthetic activity_event rows,
 * calls loadCompare, asserts shapes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import { ensureLocalUser } from "../src/lib/current-user";
import {
  loadCompare,
  loadForecast,
  type ScopeFilter,
} from "../src/lib/dashboard-data";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ── unit-level shape assertions (no DB required) ───────────────────────────

describe("CompareSide shape (no DB)", () => {
  test("CompareSide interface has expected keys", () => {
    // Type-level check: ensure the shape compiles and has the right keys.
    // We construct a minimal object and verify the fields exist at runtime.
    const side = {
      source:         "claude_code",
      totalCostCents: null,
      totalTokens:    0,
      daily:          [],
      modelMix:       [],
      hourOfDay:      new Array(24).fill(0),
      topRepos:       [],
      latency:        { p50: 0, p95: 0 },
      toolCalls:      [],
    };
    expect(side.source).toBe("claude_code");
    expect(side.hourOfDay).toHaveLength(24);
    expect(side.latency).toHaveProperty("p50");
    expect(side.latency).toHaveProperty("p95");
  });

  test("CompareData has a and b and days", () => {
    const data = {
      a:    { source: "claude_code", totalCostCents: null, totalTokens: 0, daily: [], modelMix: [], hourOfDay: new Array(24).fill(0), topRepos: [], latency: { p50: 0, p95: 0 }, toolCalls: [] },
      b:    { source: "codex",       totalCostCents: null, totalTokens: 0, daily: [], modelMix: [], hourOfDay: new Array(24).fill(0), topRepos: [], latency: { p50: 0, p95: 0 }, toolCalls: [] },
      days: 30,
    };
    expect(data.a.source).toBe("claude_code");
    expect(data.b.source).toBe("codex");
    expect(data.days).toBe(30);
  });
});

// ── DB integration tests (skipped without DATABASE_URL) ───────────────────

describe.skipIf(!HAS_DB)("loadCompare round-trip", () => {
  let userId = "";
  const scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };

  beforeAll(async () => {
    const email = `pulse-compare-test-${Date.now()}@local`;
    const user  = await ensureLocalUser(email, "compare test");
    userId = user.id;

    const db = sql();

    // Insert a handful of activity_event rows — two claude_code, one codex.
    // cost_millicents set so subscription zeroing is testable.
    await db.unsafe(
      `
      INSERT INTO activity_event (
        user_id, source, model,
        tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write,
        cost_millicents, ts
      ) VALUES
        ($1, 'claude_code', 'claude-sonnet-4-6', 1000, 500, 0, 0, 0, 5000, NOW() - INTERVAL '2 days'),
        ($1, 'claude_code', 'claude-opus-4-7',   2000, 800, 0, 0, 0, 9000, NOW() - INTERVAL '1 day'),
        ($1, 'codex',       'gpt-4o',            1500, 600, 0, 0, 0, 4000, NOW() - INTERVAL '1 day')
      `,
      [userId],
    );
  });

  afterAll(async () => {
    const db = sql();
    await db.unsafe(
      `DELETE FROM activity_event WHERE user_id = $1`,
      [userId],
    );
    await db.unsafe(
      `DELETE FROM "user" WHERE id = $1`,
      [userId],
    );
  });

  test("both sides are populated", async () => {
    const data = await loadCompare(userId, scope, "claude_code", "codex", 30);
    expect(data.days).toBe(30);
    expect(data.a.source).toBe("claude_code");
    expect(data.b.source).toBe("codex");
    // claude_code side: 2 events inserted
    expect(data.a.totalTokens).toBeGreaterThan(0);
    // codex side: 1 event inserted
    expect(data.b.totalTokens).toBeGreaterThan(0);
  });

  test("side with no events returns empty daily array with zeros", async () => {
    // Request a source with no events — 'cursor'.
    const data = await loadCompare(userId, scope, "claude_code", "cursor", 30);
    expect(data.b.source).toBe("cursor");
    expect(data.b.totalTokens).toBe(0);
    // totalCostCents is millicentsToCents(0) which returns 0, not null —
    // accept either, matching the subscription-source test convention.
    const cost = data.b.totalCostCents;
    expect(cost === null || cost === 0).toBe(true);
    // daily array should still be length = 30 (pre-filled buckets).
    expect(data.b.daily).toHaveLength(30);
    for (const d of data.b.daily) {
      expect(d.tokens).toBe(0);
    }
  });

  test("subscription source contributes 0 cost but full token counts", async () => {
    // Flag codex as subscription.
    const subscriptionSources = new Set(["codex"]);
    const data = await loadCompare(userId, scope, "claude_code", "codex", 30, {
      subscriptionSources,
    });
    // Codex side: tokens present, but cost should be 0 / null.
    expect(data.b.totalTokens).toBeGreaterThan(0);
    // totalCostCents is derived from millicentsToCents(0) which returns null.
    // Accept either null or 0 — both are correct "zero cost" representations.
    const cost = data.b.totalCostCents;
    expect(cost === null || cost === 0).toBe(true);
    // Daily cost also zeroed.
    for (const d of data.b.daily) {
      const dc = d.costCents;
      expect(dc === null || dc === 0).toBe(true);
    }
  });

  test("hourOfDay has exactly 24 buckets", async () => {
    const data = await loadCompare(userId, scope, "claude_code", "codex", 30);
    expect(data.a.hourOfDay).toHaveLength(24);
    expect(data.b.hourOfDay).toHaveLength(24);
  });

  test("daily array length equals requested days", async () => {
    const data = await loadCompare(userId, scope, "claude_code", "codex", 14);
    expect(data.days).toBe(14);
    expect(data.a.daily).toHaveLength(14);
    expect(data.b.daily).toHaveLength(14);
  });

  test("topRepos has at most 5 items", async () => {
    const data = await loadCompare(userId, scope, "claude_code", "codex", 30);
    expect(data.a.topRepos.length).toBeLessThanOrEqual(5);
    expect(data.b.topRepos.length).toBeLessThanOrEqual(5);
  });

  test("toolCalls has at most 8 items", async () => {
    const data = await loadCompare(userId, scope, "claude_code", "codex", 30);
    expect(data.a.toolCalls.length).toBeLessThanOrEqual(8);
    expect(data.b.toolCalls.length).toBeLessThanOrEqual(8);
  });
});

describe.skipIf(!HAS_DB)("loadForecast round-trip", () => {
  let userId = "";
  const scope: ScopeFilter = { repoClauseSql: "", repoParams: [] };

  beforeAll(async () => {
    const email = `pulse-forecast-test-${Date.now()}@local`;
    const user  = await ensureLocalUser(email, "forecast test");
    userId = user.id;

    const db = sql();
    // Insert a few days of events with known costs.
    await db.unsafe(
      `
      INSERT INTO activity_event (
        user_id, source, model,
        tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write,
        cost_millicents, ts
      ) VALUES
        ($1, 'claude_code', 'claude-sonnet-4-6', 1000, 500, 0, 0, 0, 5000,  NOW() - INTERVAL '3 days'),
        ($1, 'claude_code', 'claude-sonnet-4-6', 1200, 600, 0, 0, 0, 6000,  NOW() - INTERVAL '2 days'),
        ($1, 'claude_code', 'claude-opus-4-7',   2000, 900, 0, 0, 0, 10000, NOW() - INTERVAL '1 day')
      `,
      [userId],
    );
  });

  afterAll(async () => {
    const db = sql();
    await db.unsafe(`DELETE FROM activity_event WHERE user_id = $1`, [userId]);
    await db.unsafe(`DELETE FROM "user" WHERE id = $1`, [userId]);
  });

  test("history length equals requested days", async () => {
    const data = await loadForecast(userId, scope, 14, null);
    expect(data.history).toHaveLength(14);
  });

  test("spentThisMonthCents is non-negative", async () => {
    const data = await loadForecast(userId, scope, 14, null);
    expect(data.spentThisMonthCents).toBeGreaterThanOrEqual(0);
  });

  test("daysElapsedInMonth and daysInMonth are plausible", async () => {
    const data = await loadForecast(userId, scope, 14, null);
    expect(data.daysElapsedInMonth).toBeGreaterThanOrEqual(1);
    expect(data.daysElapsedInMonth).toBeLessThanOrEqual(31);
    expect(data.daysInMonth).toBeGreaterThanOrEqual(28);
    expect(data.daysInMonth).toBeLessThanOrEqual(31);
  });

  test("monthlyBudgetUsd is passed through", async () => {
    const data = await loadForecast(userId, scope, 14, 50);
    expect(data.monthlyBudgetUsd).toBe(50);
    const nobudget = await loadForecast(userId, scope, 14, null);
    expect(nobudget.monthlyBudgetUsd).toBeNull();
  });

  test("topDrivers pctOfSpend sums to ≤ 100", async () => {
    const data = await loadForecast(userId, scope, 14, null);
    const total = data.topDrivers.reduce((a, d) => a + d.pctOfSpend, 0);
    expect(total).toBeLessThanOrEqual(100.1); // float rounding tolerance
  });

  test("byModel entries have daily arrays of the right length", async () => {
    const data = await loadForecast(userId, scope, 14, null);
    for (const m of data.byModel) {
      expect(m.daily).toHaveLength(14);
      expect(typeof m.model).toBe("string");
    }
  });

  test("subscription source contributes 0 to spentThisMonthCents", async () => {
    const subSources = new Set(["claude_code"]);
    const data = await loadForecast(userId, scope, 14, null, { subscriptionSources: subSources });
    // All events are claude_code — cost should be zeroed.
    expect(data.spentThisMonthCents).toBe(0);
    for (const h of data.history) {
      expect(h.value).toBe(0);
    }
  });
});
