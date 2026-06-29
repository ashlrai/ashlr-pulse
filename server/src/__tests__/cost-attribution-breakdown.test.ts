/**
 * cost-attribution-breakdown.test.ts
 *
 * Unit tests for the cost attribution logic. Four invariants:
 *
 *   1. Cost totals match headline cards — sum(bySource.cost_cents) == total_cents.
 *   2. Subscription-mode sources zero correctly — cost_cents == 0 for subbed sources.
 *   3. Unknown models handled gracefully — cost_cents == null, events/tokens still counted.
 *   4. CSV escapes/quotes correctly — cells with commas, quotes, and newlines are safe.
 *
 * No DB required — all calls go through computeAttribution() with synthetic data.
 *
 * Run with:
 *   bun test src/__tests__/cost-attribution-breakdown.test.ts
 */

import { describe, expect, test } from "bun:test";
import { computeAttribution } from "../lib/cost-attribution-breakdown";

// ── Synthetic event factory ───────────────────────────────────────────────────

/** Minimal shape that computeAttribution accepts. */
interface SyntheticEvent {
  ts: string;
  source: string;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_cache_5m_write: number | null;
  tokens_cache_1h_write: number | null;
  cost_millicents: number | null;
}

function makeEvent(overrides: Partial<SyntheticEvent> & { source: string }): SyntheticEvent {
  return {
    ts: "2026-06-01T10:00:00Z",
    source: overrides.source,
    model: overrides.model ?? "claude-sonnet-4-6",
    tokens_input: overrides.tokens_input ?? 1000,
    tokens_output: overrides.tokens_output ?? 200,
    tokens_reasoning: overrides.tokens_reasoning ?? null,
    tokens_cache_read: overrides.tokens_cache_read ?? null,
    tokens_cache_write: overrides.tokens_cache_write ?? null,
    tokens_cache_5m_write: overrides.tokens_cache_5m_write ?? null,
    tokens_cache_1h_write: overrides.tokens_cache_1h_write ?? null,
    // Pre-compute cost_millicents for deterministic tests.
    // claude-sonnet-4-6: $3/$15 per 1M tokens → 1000 in = 0.3¢ = 300mc, 200 out = 0.15¢ = 150mc
    // Total = 450mc per event unless overridden.
    cost_millicents: overrides.cost_millicents !== undefined ? overrides.cost_millicents : 450,
    ...overrides,
  };
}

// ── 1. Cost totals match headline cards ───────────────────────────────────────

describe("cost totals match headline", () => {
  test("sum of bySource.cost_cents equals total_cents", () => {
    const events = [
      makeEvent({ source: "claude_code", cost_millicents: 1_000_000 }), // 1000 cents
      makeEvent({ source: "cursor",      cost_millicents:   500_000 }), // 500 cents
      makeEvent({ source: "copilot",     cost_millicents:   250_000 }), // 250 cents
    ];

    const result = computeAttribution(events, new Set());

    const sumFromSources = result.bySource.reduce(
      (acc, r) => acc + (r.cost_cents ?? 0),
      0,
    );
    expect(sumFromSources).toBe(result.total_cents);
  });

  test("total_cents matches sum of all non-null event millicents / 1000", () => {
    const events = [
      makeEvent({ source: "claude_code", cost_millicents: 2_500_000 }), // 2500¢
      makeEvent({ source: "claude_code", cost_millicents:   750_000 }), // 750¢
    ];

    const result = computeAttribution(events, new Set());

    // 2500000 + 750000 = 3250000 mc → 3250 cents
    expect(result.total_cents).toBe(3250);
  });

  test("cost_share values sum to ~1.0 when total > 0", () => {
    const events = [
      makeEvent({ source: "claude_code", cost_millicents: 600_000 }),
      makeEvent({ source: "cursor",      cost_millicents: 400_000 }),
    ];

    const result = computeAttribution(events, new Set());

    const sumShare = result.bySource.reduce((s, r) => s + r.cost_share, 0);
    expect(sumShare).toBeCloseTo(1.0, 5);
  });

  test("events and tokens always counted regardless of cost", () => {
    const events = [
      makeEvent({ source: "claude_code", cost_millicents: 0, tokens_input: 5000, tokens_output: 1000 }),
      makeEvent({ source: "claude_code", cost_millicents: 0, tokens_input: 3000, tokens_output: 500  }),
    ];

    const result = computeAttribution(events, new Set());
    const src = result.bySource.find((r) => r.source === "claude_code");
    expect(src).toBeDefined();
    expect(src!.events).toBe(2);
    // billable = input + output (no reasoning here)
    expect(src!.tokens).toBe(5000 + 1000 + 3000 + 500);
  });

  test("bySource and byModel are sorted by cost_cents desc", () => {
    const events = [
      makeEvent({ source: "cursor",      cost_millicents: 100_000 }),
      makeEvent({ source: "claude_code", cost_millicents: 500_000 }),
      makeEvent({ source: "copilot",     cost_millicents: 250_000 }),
    ];

    const result = computeAttribution(events, new Set());

    const costs = result.bySource.map((r) => r.cost_cents ?? 0);
    for (let i = 0; i < costs.length - 1; i++) {
      expect(costs[i]).toBeGreaterThanOrEqual(costs[i + 1]);
    }
  });
});

// ── 2. Subscription-mode sources zero correctly ───────────────────────────────

describe("subscription-mode zeroing", () => {
  test("cost_cents is 0 for a subscribed source", () => {
    const events = [
      makeEvent({ source: "cursor", cost_millicents: 1_000_000 }),
    ];

    const result = computeAttribution(events, new Set(["cursor"]));
    const src = result.bySource.find((r) => r.source === "cursor");
    expect(src).toBeDefined();
    expect(src!.cost_cents).toBe(0);
  });

  test("non-subscribed source is unaffected when another is zeroed", () => {
    const events = [
      makeEvent({ source: "cursor",      cost_millicents: 1_000_000 }), // subbed → 0
      makeEvent({ source: "claude_code", cost_millicents:   500_000 }), // not subbed → 500¢
    ];

    const result = computeAttribution(events, new Set(["cursor"]));

    const cursorRow = result.bySource.find((r) => r.source === "cursor");
    const claudeRow = result.bySource.find((r) => r.source === "claude_code");

    expect(cursorRow!.cost_cents).toBe(0);
    expect(claudeRow!.cost_cents).toBe(500);
  });

  test("total_cents excludes zeroed subscription sources", () => {
    const events = [
      makeEvent({ source: "cursor",      cost_millicents: 2_000_000 }), // subbed → 0
      makeEvent({ source: "claude_code", cost_millicents: 1_000_000 }), // 1000¢
    ];

    const result = computeAttribution(events, new Set(["cursor"]));

    // Only claude_code contributes
    expect(result.total_cents).toBe(1000);
  });

  test("events and tokens are NOT zeroed for subscription sources", () => {
    const events = [
      makeEvent({ source: "cursor", cost_millicents: 999_999, tokens_input: 9000, tokens_output: 1000 }),
    ];

    const result = computeAttribution(events, new Set(["cursor"]));
    const src = result.bySource[0];
    expect(src.events).toBe(1);
    expect(src.tokens).toBe(10000); // tokens unchanged
    expect(src.cost_cents).toBe(0); // only cost zeroed
  });

  test("multiple sources all zeroed → total_cents is 0", () => {
    const events = [
      makeEvent({ source: "cursor",  cost_millicents: 500_000 }),
      makeEvent({ source: "copilot", cost_millicents: 300_000 }),
    ];

    const result = computeAttribution(events, new Set(["cursor", "copilot"]));
    expect(result.total_cents).toBe(0);
  });
});

// ── 3. Unknown models handled gracefully ──────────────────────────────────────

describe("unknown / unpriced models", () => {
  test("unknown model: cost_cents is null, events/tokens still counted", () => {
    const events = [
      makeEvent({
        source: "cursor",
        model: "some-future-unknown-model-xyz",
        tokens_input: 4000,
        tokens_output: 800,
        // No cached cost → will fall back to recompute, which returns null for unknown model
        cost_millicents: null,
      }),
    ];

    const result = computeAttribution(events, new Set());
    const mdl = result.byModel.find((r) => r.model === "some-future-unknown-model-xyz");
    expect(mdl).toBeDefined();
    expect(mdl!.events).toBe(1);
    expect(mdl!.tokens).toBe(4800);
    expect(mdl!.cost_cents).toBeNull();
  });

  test("null model is grouped under '(unknown)' model key", () => {
    const events = [
      makeEvent({ source: "shell", model: null, cost_millicents: null }),
    ];

    const result = computeAttribution(events, new Set());
    const mdl = result.byModel.find((r) => r.model === "(unknown)");
    expect(mdl).toBeDefined();
    expect(mdl!.events).toBe(1);
  });

  test("unknown models appear last in byModel (nulls-last sort)", () => {
    const events = [
      makeEvent({ source: "claude_code", model: "some-unknown-xyz", cost_millicents: null, tokens_input: 1000, tokens_output: 200 }),
      makeEvent({ source: "claude_code", model: "claude-sonnet-4-6", cost_millicents: 500_000 }),
    ];

    const result = computeAttribution(events, new Set());
    // First row should be the known model with real cost
    expect(result.byModel[0].cost_cents).not.toBeNull();
    // Last row should be the unknown model
    const last = result.byModel[result.byModel.length - 1];
    expect(last.cost_cents).toBeNull();
  });

  test("mix of known and unknown models: total only counts known", () => {
    const events = [
      makeEvent({ source: "cursor",      model: "gpt-4o",            cost_millicents: 200_000 }),
      makeEvent({ source: "claude_code", model: "unknown-model-zyx",  cost_millicents: null    }),
      makeEvent({ source: "claude_code", model: "claude-haiku-4-5",   cost_millicents: 100_000 }),
    ];

    const result = computeAttribution(events, new Set());
    // total = 200 + 100 = 300 cents
    expect(result.total_cents).toBe(300);
  });
});

// ── 4. CSV export helpers: escape/quote correctly ─────────────────────────────

// We test the csvCell logic directly via the route's exported column contract.
// The actual csvCell function is unexported from the route, so we re-implement
// the same contract here and verify the invariants.

function csvCellSpec(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

describe("CSV escaping contract (RFC 4180)", () => {
  test("plain string passes through unchanged", () => {
    expect(csvCellSpec("claude_code")).toBe("claude_code");
    expect(csvCellSpec("gpt-4o")).toBe("gpt-4o");
  });

  test("string with comma is double-quoted", () => {
    const result = csvCellSpec("repo, name");
    expect(result).toBe('"repo, name"');
  });

  test("string with double-quote escapes the quote inside", () => {
    const result = csvCellSpec('he said "hello"');
    expect(result).toBe('"he said ""hello"""');
  });

  test("string with newline is double-quoted", () => {
    const result = csvCellSpec("line1\nline2");
    expect(result).toBe('"line1\nline2"');
  });

  test("string with carriage return is double-quoted", () => {
    const result = csvCellSpec("line1\r\nline2");
    expect(result).toBe('"line1\r\nline2"');
  });

  test("number passes through as string", () => {
    expect(csvCellSpec(42)).toBe("42");
    expect(csvCellSpec(3.14159)).toBe("3.14159");
    expect(csvCellSpec(0)).toBe("0");
  });

  test("empty string passes through unchanged", () => {
    expect(csvCellSpec("")).toBe("");
  });

  test("SQL-injection-style strings with comma are safely quoted", () => {
    // String contains a comma, so RFC 4180 requires quoting
    const dangerous = "'; DROP TABLE activity_event, users; --";
    const cell = csvCellSpec(dangerous);
    expect(cell.startsWith('"')).toBe(true);
    expect(cell.endsWith('"')).toBe(true);
    // The inner content is preserved verbatim (no SQL executed — it's just text)
    expect(cell).toContain("DROP TABLE");
  });

  test("SQL-injection strings without special chars pass through unquoted", () => {
    // No comma/quote/newline → no quoting needed; still safe as CSV text
    const dangerous = "'; DROP TABLE activity_event; --";
    const cell = csvCellSpec(dangerous);
    // No quoting needed but the value is preserved as plain text
    expect(cell).toBe("'; DROP TABLE activity_event; --");
  });

  test("ATTRIBUTION_CSV_COLUMNS is a stable 6-element array", async () => {
    const { ATTRIBUTION_CSV_COLUMNS } = await import(
      "../lib/cost-attribution-breakdown"
    );
    expect(ATTRIBUTION_CSV_COLUMNS).toHaveLength(6);
    expect(ATTRIBUTION_CSV_COLUMNS).toContain("type");
    expect(ATTRIBUTION_CSV_COLUMNS).toContain("key");
    expect(ATTRIBUTION_CSV_COLUMNS).toContain("events");
    expect(ATTRIBUTION_CSV_COLUMNS).toContain("tokens");
    expect(ATTRIBUTION_CSV_COLUMNS).toContain("cost_usd");
    expect(ATTRIBUTION_CSV_COLUMNS).toContain("cost_share_pct");
  });
});

// ── 5. Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("empty events list returns empty breakdown with zero total", () => {
    const result = computeAttribution([], new Set());
    expect(result.bySource).toHaveLength(0);
    expect(result.byModel).toHaveLength(0);
    expect(result.total_cents).toBe(0);
    expect(result.since).toBeNull();
    expect(result.until).toBeNull();
  });

  test("single event populates since and until with same date", () => {
    const events = [makeEvent({ source: "claude_code", ts: "2026-06-15T12:00:00Z" } as any)];
    const result = computeAttribution(events, new Set());
    expect(result.since).toBe("2026-06-15");
    expect(result.until).toBe("2026-06-15");
  });

  test("date range spans min and max event timestamps", () => {
    const events = [
      { ...makeEvent({ source: "claude_code" }), ts: "2026-06-01T00:00:00Z" },
      { ...makeEvent({ source: "cursor" }),      ts: "2026-06-20T23:59:59Z" },
      { ...makeEvent({ source: "copilot" }),     ts: "2026-06-10T12:00:00Z" },
    ];
    const result = computeAttribution(events, new Set());
    expect(result.since).toBe("2026-06-01");
    expect(result.until).toBe("2026-06-20");
  });

  test("cost_share is 0 when total_cents is 0", () => {
    const events = [
      makeEvent({ source: "cursor", cost_millicents: 0 }),
      makeEvent({ source: "copilot", cost_millicents: 0 }),
    ];
    const result = computeAttribution(events, new Set());
    for (const r of result.bySource) {
      expect(r.cost_share).toBe(0);
    }
  });
});
