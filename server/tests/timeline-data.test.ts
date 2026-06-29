/**
 * timeline-data.test.ts — unit + integration tests for the timeline
 * aggregation layer.
 *
 * Pure-function tests run without a DB. DB integration tests are skipped
 * when DATABASE_URL is not set (same pattern as granularity.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildHourKey,
  clampDays,
  rebaseScopePlaceholders,
  loadTimeline,
  type TimelineLoadOpts,
} from "../src/lib/timeline-data";

// ─── Pure-function tests ───────────────────────────────────────────────────────

describe("clampDays", () => {
  test("defaults to 7 for invalid inputs", () => {
    expect(clampDays(0)).toBe(7);
    expect(clampDays(-1)).toBe(7);
    expect(clampDays(NaN)).toBe(7);
    expect(clampDays(Infinity)).toBe(7);
  });

  test("passes through valid values", () => {
    expect(clampDays(1)).toBe(1);
    expect(clampDays(7)).toBe(7);
    expect(clampDays(14)).toBe(14);
    expect(clampDays(30)).toBe(30);
  });

  test("clamps to MAX_DAYS (30)", () => {
    expect(clampDays(31)).toBe(30);
    expect(clampDays(90)).toBe(30);
  });

  test("truncates floats", () => {
    expect(clampDays(7.9)).toBe(7);
    expect(clampDays(14.1)).toBe(14);
  });
});

describe("buildHourKey", () => {
  test("truncates timestamp to the hour boundary", () => {
    expect(buildHourKey("2026-06-17T14:37:22.000Z")).toBe("2026-06-17T14:00Z");
    expect(buildHourKey("2026-06-17T00:00:00.000Z")).toBe("2026-06-17T00:00Z");
    expect(buildHourKey("2026-06-17T23:59:59.999Z")).toBe("2026-06-17T23:00Z");
  });

  test("produces consistent keys for the same hour", () => {
    const a = buildHourKey("2026-06-17T14:10:00.000Z");
    const b = buildHourKey("2026-06-17T14:55:59.999Z");
    expect(a).toBe(b);
  });

  test("different hours produce different keys", () => {
    const a = buildHourKey("2026-06-17T13:59:59.999Z");
    const b = buildHourKey("2026-06-17T14:00:00.000Z");
    expect(a).not.toBe(b);
  });
});

describe("rebaseScopePlaceholders", () => {
  test("returns empty string when clause is empty", () => {
    expect(rebaseScopePlaceholders("", 8)).toBe("");
  });

  test("rebases single placeholder", () => {
    expect(rebaseScopePlaceholders("AND repo_name LIKE $4", 8)).toBe(
      "AND repo_name LIKE $8",
    );
  });

  test("rebases multiple placeholders sequentially", () => {
    const result = rebaseScopePlaceholders(
      "AND (repo_name = $4 OR repo_name = $5)",
      10,
    );
    expect(result).toBe("AND (repo_name = $10 OR repo_name = $11)");
  });

  test("handles firstIndex = 1 (no-op for $1)", () => {
    expect(rebaseScopePlaceholders("AND x = $1", 1)).toBe("AND x = $1");
  });
});

describe("TimelineLoadOpts groupBySession flag", () => {
  test("groupBySession defaults to undefined (falsy)", () => {
    const opts: TimelineLoadOpts = {};
    expect(opts.groupBySession).toBeUndefined();
    // Falsy check mirrors how the data layer uses it
    expect(!opts.groupBySession).toBe(true);
  });

  test("groupBySession true is truthy", () => {
    const opts: TimelineLoadOpts = { groupBySession: true };
    expect(opts.groupBySession).toBe(true);
  });

  test("groupBySession false is explicitly false", () => {
    const opts: TimelineLoadOpts = { groupBySession: false };
    expect(opts.groupBySession).toBe(false);
  });
});

// ─── DB integration tests ─────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("loadTimeline (DB)", () => {
  // Lazy-import DB helpers only when DB is present so pure-function tests
  // don't fail from missing connection strings.
  let userId: string;
  const testEmail = `pulse-timeline-test-${Date.now()}@local`;

  beforeAll(async () => {
    const { sql } = await import("../src/lib/db");
    const { ensureLocalUser } = await import("../src/lib/current-user");

    const user = await ensureLocalUser(testEmail, null);
    userId = user.id;

    const db = sql();
    // Seed a handful of events across two hours and two sources.
    await db`
      INSERT INTO activity_event
        (ts, user_id, source, model, tokens_input, tokens_output, cost_millicents, tool_calls_types)
      VALUES
        (NOW() - INTERVAL '1 hour',  ${userId}, 'claude_code', 'claude-opus-4-7', 100, 200, 5000, ARRAY['bash', 'read']),
        (NOW() - INTERVAL '2 hours', ${userId}, 'claude_code', 'claude-opus-4-7', 80,  150, 4000, ARRAY['edit']),
        (NOW() - INTERVAL '3 hours', ${userId}, 'cursor',      'gpt-4o',          50,   80, 2000, NULL)
    `;
  });

  afterAll(async () => {
    const { sql } = await import("../src/lib/db");
    const db = sql();
    await db`DELETE FROM activity_event WHERE user_id = ${userId}`;
    await db`DELETE FROM "user" WHERE email = ${testEmail}`;
  });

  test("returns expected event count for a 7d window", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    expect(tl.totalEvents).toBeGreaterThanOrEqual(3);
  });

  test("hourly buckets are sorted ascending", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    for (let i = 1; i < tl.hourly.length; i++) {
      expect(tl.hourly[i].hour >= tl.hourly[i - 1].hour).toBe(true);
    }
  });

  test("events array is non-empty and has required fields", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    expect(tl.events.length).toBeGreaterThanOrEqual(3);
    for (const ev of tl.events) {
      expect(typeof ev.id).toBe("string");
      expect(typeof ev.ts).toBe("string");
      expect(typeof ev.source).toBe("string");
    }
  });

  test("sources list contains claude_code and cursor", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    expect(tl.sources).toContain("claude_code");
    expect(tl.sources).toContain("cursor");
  });

  test("tools list contains tool names from seeded events", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    expect(tl.tools).toContain("bash");
    expect(tl.tools).toContain("read");
    expect(tl.tools).toContain("edit");
  });

  test("sourceFilter restricts to matching events", async () => {
    const tl = await loadTimeline(
      userId,
      { repoClauseSql: "", repoParams: [] },
      { days: 7, sourceFilter: "cursor" },
    );
    for (const ev of tl.events) {
      expect(ev.source).toBe("cursor");
    }
  });

  test("toolFilter restricts to events with matching tool", async () => {
    const tl = await loadTimeline(
      userId,
      { repoClauseSql: "", repoParams: [] },
      { days: 7, toolFilter: "bash" },
    );
    for (const ev of tl.events) {
      expect(
        ev.tool_calls_types?.some((t) => t.toLowerCase().includes("bash")) ?? false,
      ).toBe(true);
    }
  });

  test("totalTokens sums input + output (billable only)", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    // At minimum the 3 seeded events: (100+200) + (80+150) + (50+80) = 660
    expect(tl.totalTokens).toBeGreaterThanOrEqual(660);
  });

  test("totalCostCents is non-negative", async () => {
    const tl = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7 });
    expect(tl.totalCostCents).toBeGreaterThanOrEqual(0);
  });

  test("days field reflects the requested window", async () => {
    const tl7  = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 7  });
    const tl14 = await loadTimeline(userId, { repoClauseSql: "", repoParams: [] }, { days: 14 });
    expect(tl7.days).toBe(7);
    expect(tl14.days).toBe(14);
  });

  test("groupBySession produces sessions array (even without session_ids)", async () => {
    const tl = await loadTimeline(
      userId,
      { repoClauseSql: "", repoParams: [] },
      { days: 7, groupBySession: true },
    );
    // Sessions may be empty if no session_id values are set in test data;
    // the structure must still be a valid array.
    expect(Array.isArray(tl.sessions)).toBe(true);
    // All flat events are still returned.
    expect(tl.events.length).toBeGreaterThanOrEqual(3);
  });

  test("sinceISO / untilISO date filters are respected", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const tl = await loadTimeline(
      userId,
      { repoClauseSql: "", repoParams: [] },
      { days: 7, untilISO: future },
    );
    // All events should be before the future upper bound.
    for (const ev of tl.events) {
      expect(new Date(ev.ts) < new Date(future)).toBe(true);
    }
  });
});
