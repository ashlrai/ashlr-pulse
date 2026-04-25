/**
 * granularity.test.ts — verify granularity rollup + field whitelist logic.
 *
 * Tests the pure helper functions extracted from page.tsx (granularity
 * selection, field allow-list intersection) plus a live DB round-trip that
 * seeds activity_event rows and asserts the bucketed query returns the
 * expected shape.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import { ensureLocalUser } from "../src/lib/current-user";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure-function tests (no DB required)
// ---------------------------------------------------------------------------

type Granularity = "realtime" | "daily" | "weekly" | "monthly";

const GRAN_ORDER: Granularity[] = ["monthly", "weekly", "daily", "realtime"];

function mostPermissive(grans: Granularity[]): Granularity {
  let best: Granularity = "monthly";
  for (const g of grans) {
    if (GRAN_ORDER.indexOf(g) > GRAN_ORDER.indexOf(best)) best = g;
  }
  return best;
}

function windowForGranularity(gran: Granularity): string {
  switch (gran) {
    case "realtime": return "24 hours";
    case "daily":    return "7 days";
    case "weekly":   return "90 days";
    case "monthly":  return "1 year";
  }
}

describe("granularity helpers (pure)", () => {
  test("mostPermissive picks realtime when any grant is realtime", () => {
    expect(mostPermissive(["monthly", "weekly", "realtime"])).toBe("realtime");
  });
  test("mostPermissive picks daily over weekly/monthly", () => {
    expect(mostPermissive(["monthly", "weekly", "daily"])).toBe("daily");
  });
  test("mostPermissive falls back to monthly with single grant", () => {
    expect(mostPermissive(["monthly"])).toBe("monthly");
  });
  test("windowForGranularity maps correctly", () => {
    expect(windowForGranularity("realtime")).toBe("24 hours");
    expect(windowForGranularity("daily")).toBe("7 days");
    expect(windowForGranularity("weekly")).toBe("90 days");
    expect(windowForGranularity("monthly")).toBe("1 year");
  });
});

describe("field whitelist helpers (pure)", () => {
  const COLUMN_FIELDS: Record<string, string> = {
    source:     "source",
    model:      "model",
    tokens_in:  "tokens_input",
    tokens_out: "tokens_output",
  };

  function buildAllowed(fieldSets: string[][]): Set<string> {
    const s = new Set<string>();
    for (const fs of fieldSets) for (const f of fs) s.add(f);
    return s;
  }

  function colAllowed(col: string, allowed: Set<string> | null): boolean {
    if (allowed === null) return true;
    const field = COLUMN_FIELDS[col];
    if (!field) return true;
    return allowed.has(field);
  }

  test("null allowed = unrestricted (own view)", () => {
    expect(colAllowed("model", null)).toBe(true);
    expect(colAllowed("tokens_in", null)).toBe(true);
  });

  test("single grant with only tokens_input allows tokens_in, blocks model", () => {
    const allowed = buildAllowed([["tokens_input"]]);
    expect(colAllowed("tokens_in", allowed)).toBe(true);
    expect(colAllowed("model", allowed)).toBe(false);
    expect(colAllowed("source", allowed)).toBe(false);
  });

  test("union of two grants merges fields", () => {
    const allowed = buildAllowed([["tokens_input"], ["model", "source"]]);
    expect(colAllowed("tokens_in", allowed)).toBe(true);
    expect(colAllowed("model", allowed)).toBe(true);
    expect(colAllowed("source", allowed)).toBe(true);
    expect(colAllowed("tokens_out", allowed)).toBe(false);
  });

  test("events column (no mapping) is always shown", () => {
    const allowed = buildAllowed([["tokens_input"]]);
    expect(colAllowed("events", allowed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB integration — verify bucketed query shape
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("granularity bucketed query (DB)", () => {
  const testEmail = `pulse-gran-test-${Date.now()}@local`;
  let userId: string;

  beforeAll(async () => {
    const user = await ensureLocalUser(testEmail, null);
    userId = user.id;

    // Seed one event today and one 3 days ago.
    const db = sql();
    await db`
      INSERT INTO activity_event (ts, user_id, source, model, tokens_input, tokens_output)
      VALUES
        (NOW(),                           ${userId}, 'claude_code', 'claude-opus-4-7', 100, 200),
        (NOW() - INTERVAL '3 days',       ${userId}, 'cursor',      'gpt-4o',          50,  80)
    `;
  });

  afterAll(async () => {
    const db = sql();
    await db`DELETE FROM activity_event WHERE user_id = ${userId}`;
    await db`DELETE FROM "user" WHERE email = ${testEmail}`;
  });

  test("realtime window (24h) returns only today's event", async () => {
    const db = sql();
    const rows = await db<{ events: number; source: string }[]>`
      SELECT COUNT(*)::int AS events, source
      FROM activity_event
      WHERE user_id = ${userId}
        AND ts >= NOW() - INTERVAL '24 hours'
      GROUP BY source
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("claude_code");
  });

  test("daily window (7 days) returns both events, bucketed by day", async () => {
    const db = sql();
    const rows = await db<{ events: number; bucket: string; source: string }[]>`
      SELECT date_trunc('day', ts)::text AS bucket, source, COUNT(*)::int AS events
      FROM activity_event
      WHERE user_id = ${userId}
        AND ts >= NOW() - INTERVAL '7 days'
      GROUP BY bucket, source
      ORDER BY bucket DESC
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const sources = rows.map((r) => r.source);
    expect(sources).toContain("claude_code");
    expect(sources).toContain("cursor");
    // Every row has a non-null bucket string.
    for (const r of rows) expect(r.bucket).toBeTruthy();
  });
});
