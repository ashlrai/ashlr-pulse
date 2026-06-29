/**
 * session-attribution.test.ts — integration tests for lib/session-attribution.ts.
 *
 * All tests are pure (no DB). They use fixture spans with known costs so
 * every assertion is deterministic.
 *
 * Suites:
 *   1. Phase binning — tools route to the correct phase bucket
 *   2. Cost totals — totalCostUsd matches sum of span millicents
 *   3. Phase aggregates — per-phase cost sums are correct
 *   4. Top-5 ranking — correct calls flagged as isTopCost
 *   5. Efficiency outliers — high cost/token + low token calls flagged
 *   6. CSV export — correct columns, correct row count, no NaN/null in money fields
 *   7. Edge cases — empty spans, zero-cost spans, single span
 */

import { describe, test, expect } from "bun:test";
import {
  computeSessionAttribution,
  attributionToCsv,
  ATTRIBUTION_CSV_COLUMNS,
  type RawSessionSpan,
} from "../src/lib/session-attribution";

// ── Fixture helpers ──────────────────────────────────────────────────────────

const BASE_TS = new Date("2026-06-01T09:00:00.000Z").getTime();

function span(
  overrides: Partial<RawSessionSpan> & { tool: string; costMillicents?: number },
): RawSessionSpan {
  const { tool, costMillicents, ...rest } = overrides;
  return {
    ts: new Date(BASE_TS).toISOString(),
    duration_ms: 500,
    tool_calls_types: [tool],
    tokens_input: 100,
    tokens_output: 50,
    tokens_reasoning: null,
    cost_millicents: costMillicents ?? 1000, // 1000 mc = $0.00001
    repo_name: "my/repo",
    source: "claude_code",
    model: "claude-sonnet-4-6",
    ...rest,
  };
}

function seq(
  items: Array<{ tool: string; costMillicents?: number; tokensIn?: number; tokensOut?: number }>,
): RawSessionSpan[] {
  return items.map((item, i) =>
    span({
      tool: item.tool,
      costMillicents: item.costMillicents,
      ts: new Date(BASE_TS + i * 1000).toISOString(),
      tokens_input: item.tokensIn ?? 100,
      tokens_output: item.tokensOut ?? 50,
    }),
  );
}

// ── 1. Phase binning ──────────────────────────────────────────────────────────

describe("phase binning", () => {
  test("ls → setup", () => {
    const p = computeSessionAttribution("s", [span({ tool: "ls" })]);
    expect(p.toolCalls[0].phase).toBe("setup");
  });

  test("glob → setup", () => {
    const p = computeSessionAttribution("s", [span({ tool: "glob" })]);
    expect(p.toolCalls[0].phase).toBe("setup");
  });

  test("read → exploration", () => {
    const p = computeSessionAttribution("s", [span({ tool: "read" })]);
    expect(p.toolCalls[0].phase).toBe("exploration");
  });

  test("grep → exploration", () => {
    const p = computeSessionAttribution("s", [span({ tool: "grep" })]);
    expect(p.toolCalls[0].phase).toBe("exploration");
  });

  test("edit → execution", () => {
    const p = computeSessionAttribution("s", [span({ tool: "edit" })]);
    expect(p.toolCalls[0].phase).toBe("execution");
  });

  test("bash → execution", () => {
    const p = computeSessionAttribution("s", [span({ tool: "bash" })]);
    expect(p.toolCalls[0].phase).toBe("execution");
  });

  test("diff → review", () => {
    const p = computeSessionAttribution("s", [span({ tool: "diff" })]);
    expect(p.toolCalls[0].phase).toBe("review");
  });

  test("test → review", () => {
    const p = computeSessionAttribution("s", [span({ tool: "test" })]);
    expect(p.toolCalls[0].phase).toBe("review");
  });

  test("unknown tool → execution (default)", () => {
    const p = computeSessionAttribution("s", [span({ tool: "magic_wand" })]);
    expect(p.toolCalls[0].phase).toBe("execution");
  });

  test("tool_calls_types normalisation: 'str_replace_editor' → edit → execution", () => {
    const s = span({ tool: "str_replace_editor" });
    const p = computeSessionAttribution("s", [s]);
    expect(p.toolCalls[0].tool).toBe("edit");
    expect(p.toolCalls[0].phase).toBe("execution");
  });
});

// ── 2. Cost totals ────────────────────────────────────────────────────────────

describe("cost totals", () => {
  test("totalCostUsd matches sum of span millicents", () => {
    // 3 spans × 1000 mc each → 3000 mc → 3000 / 100_000 = $0.03
    const spans = seq([
      { tool: "read",  costMillicents: 1000 },
      { tool: "edit",  costMillicents: 2000 },
      { tool: "bash",  costMillicents: 500  },
    ]);
    const p = computeSessionAttribution("s", spans);
    expect(p.totalCostUsd).toBeCloseTo((1000 + 2000 + 500) / 100_000, 8);
  });

  test("zero-cost spans have totalCostUsd = 0", () => {
    const spans = seq([
      { tool: "read", costMillicents: 0 },
      { tool: "bash", costMillicents: 0 },
    ]);
    const p = computeSessionAttribution("s", spans);
    expect(p.totalCostUsd).toBe(0);
  });

  test("null cost_millicents treated as 0", () => {
    const s = span({ tool: "read", costMillicents: undefined });
    s.cost_millicents = null;
    const p = computeSessionAttribution("s", [s]);
    expect(p.totalCostUsd).toBe(0);
  });

  test("totalTokens = sum of (tokens_input + tokens_output) across all spans", () => {
    const spans = seq([
      { tool: "read", tokensIn: 100, tokensOut: 50 },
      { tool: "edit", tokensIn: 200, tokensOut: 80 },
    ]);
    const p = computeSessionAttribution("s", spans);
    expect(p.totalTokens).toBe(100 + 50 + 200 + 80);
  });
});

// ── 3. Phase aggregates ───────────────────────────────────────────────────────

describe("phaseAggregates", () => {
  test("all four phases always present in output", () => {
    const p = computeSessionAttribution("s", [span({ tool: "read" })]);
    const phases = p.phaseAggregates.map((pa) => pa.phase);
    expect(phases).toContain("setup");
    expect(phases).toContain("exploration");
    expect(phases).toContain("execution");
    expect(phases).toContain("review");
  });

  test("exploration phase cost equals sum of read spans", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "read", costMillicents: 2000 },
      { tool: "bash", costMillicents: 500  },
    ]);
    const p = computeSessionAttribution("s", spans);
    const expl = p.phaseAggregates.find((pa) => pa.phase === "exploration")!;
    expect(expl.totalCostUsd).toBeCloseTo(3000 / 100_000, 8);
    expect(expl.calls).toBe(2);
  });

  test("execution phase cost equals sum of edit+bash spans", () => {
    const spans = seq([
      { tool: "edit", costMillicents: 3000 },
      { tool: "bash", costMillicents: 1000 },
    ]);
    const p = computeSessionAttribution("s", spans);
    const exec = p.phaseAggregates.find((pa) => pa.phase === "execution")!;
    expect(exec.totalCostUsd).toBeCloseTo(4000 / 100_000, 8);
  });

  test("costShare of all phases sums to 1 (when total > 0)", () => {
    const spans = seq([
      { tool: "ls",   costMillicents: 500  },
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 2000 },
      { tool: "diff", costMillicents: 500  },
    ]);
    const p = computeSessionAttribution("s", spans);
    const totalShare = p.phaseAggregates.reduce((s, pa) => s + pa.costShare, 0);
    expect(totalShare).toBeCloseTo(1.0, 5);
  });

  test("costShare is 0 for all phases when totalCostUsd is 0", () => {
    const spans = seq([
      { tool: "read", costMillicents: 0 },
      { tool: "edit", costMillicents: 0 },
    ]);
    const p = computeSessionAttribution("s", spans);
    for (const pa of p.phaseAggregates) {
      expect(pa.costShare).toBe(0);
    }
  });
});

// ── 4. Top-5 cost ranking ─────────────────────────────────────────────────────

describe("topCostCalls", () => {
  test("top 5 calls are the most expensive ones", () => {
    // 7 spans with distinct costs; top 5 should be the 5 highest
    const spans = seq([
      { tool: "read", costMillicents: 100   },
      { tool: "edit", costMillicents: 9000  },
      { tool: "bash", costMillicents: 5000  },
      { tool: "read", costMillicents: 200   },
      { tool: "edit", costMillicents: 8000  },
      { tool: "bash", costMillicents: 7000  },
      { tool: "read", costMillicents: 6000  },
    ]);
    const p = computeSessionAttribution("s", spans);
    expect(p.topCostCalls).toHaveLength(5);
    // Sorted desc
    const costs = p.topCostCalls.map((c) => c.costUsd);
    const sorted = [...costs].sort((a, b) => b - a);
    expect(costs).toEqual(sorted);
  });

  test("isTopCost is true for exactly top-5 entries in toolCalls", () => {
    const spans = seq([
      { tool: "read", costMillicents: 100   },
      { tool: "edit", costMillicents: 9000  },
      { tool: "bash", costMillicents: 5000  },
      { tool: "read", costMillicents: 200   },
      { tool: "edit", costMillicents: 8000  },
      { tool: "bash", costMillicents: 7000  },
      { tool: "read", costMillicents: 6000  },
    ]);
    const p = computeSessionAttribution("s", spans);
    const topCount = p.toolCalls.filter((c) => c.isTopCost).length;
    expect(topCount).toBe(5);
  });

  test("with fewer than 5 spans, all are top cost", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 2000 },
      { tool: "bash", costMillicents: 500  },
    ]);
    const p = computeSessionAttribution("s", spans);
    expect(p.topCostCalls).toHaveLength(3);
    expect(p.toolCalls.filter((c) => c.isTopCost)).toHaveLength(3);
  });

  test("topCostCalls indices match the high-cost spans", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1   }, // index 0 — cheap
      { tool: "edit", costMillicents: 9000 }, // index 1 — expensive
    ]);
    const p = computeSessionAttribution("s", spans);
    const topIndices = p.topCostCalls.map((c) => c.index);
    expect(topIndices).toContain(1);
  });
});

// ── 5. Efficiency outliers ────────────────────────────────────────────────────

describe("efficiencyOutliers", () => {
  test("high cost-per-token + low token call is flagged as outlier", () => {
    // 10 "normal" spans: 1000mc / 1000 tokens = 1e-8 USD/token
    // 1 "outlier" span: 9000mc / 5 tokens = very high cost/token
    const normal = Array.from({ length: 10 }, (_, i) =>
      span({
        tool: "read",
        costMillicents: 1000,
        ts: new Date(BASE_TS + i * 1000).toISOString(),
        tokens_input: 900,
        tokens_output: 100,
      }),
    );
    const outlier = span({
      tool: "bash",
      costMillicents: 9000,
      ts: new Date(BASE_TS + 11_000).toISOString(),
      tokens_input: 2,
      tokens_output: 3,
    });
    const p = computeSessionAttribution("s", [...normal, outlier]);
    const outlierIndices = p.efficiencyOutliers.map((c) => c.index);
    // The outlier should be in the list
    expect(outlierIndices).toContain(10);
  });

  test("no outliers when all calls have similar cost-per-token", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 1000 },
      { tool: "bash", costMillicents: 1000 },
    ]);
    // All have identical tokensIn/tokensOut so median = each value → ratio = 1, not > 2
    const p = computeSessionAttribution("s", spans);
    expect(p.efficiencyOutliers).toHaveLength(0);
  });

  test("costPerToken is null when totalTokens is 0", () => {
    const s = span({ tool: "read", costMillicents: 1000, tokens_input: 0, tokens_output: 0 });
    s.tokens_input = 0;
    s.tokens_output = 0;
    const p = computeSessionAttribution("s", [s]);
    expect(p.toolCalls[0].costPerToken).toBeNull();
  });
});

// ── 6. CSV export ─────────────────────────────────────────────────────────────

describe("attributionToCsv", () => {
  test("first row matches ATTRIBUTION_CSV_COLUMNS header", () => {
    const p = computeSessionAttribution("s", seq([{ tool: "read", costMillicents: 1000 }]));
    const csv = attributionToCsv(p);
    const [header] = csv.split("\n");
    expect(header).toBe(ATTRIBUTION_CSV_COLUMNS.join(","));
  });

  test("row count = 1 header + N tool calls", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 2000 },
      { tool: "bash", costMillicents: 500  },
    ]);
    const p = computeSessionAttribution("s", spans);
    const csv = attributionToCsv(p);
    // split on \n, filter empty trailing line
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1 + spans.length); // header + data rows
  });

  test("cost_usd column has no NaN, Infinity, or empty values", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 0    },
      { tool: "bash", costMillicents: 5000 },
    ]);
    const p = computeSessionAttribution("s", spans);
    const csv = attributionToCsv(p);
    const lines = csv.split("\n").filter((l) => l.trim().length > 0).slice(1);
    const costColIdx = ATTRIBUTION_CSV_COLUMNS.indexOf("cost_usd");
    for (const line of lines) {
      const cols = line.split(",");
      const costVal = cols[costColIdx];
      expect(costVal).not.toBe("");
      expect(costVal).not.toMatch(/NaN|Infinity/);
    }
  });

  test("is_top_cost column contains 'true' or 'false' only", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 2000 },
    ]);
    const p = computeSessionAttribution("s", spans);
    const csv = attributionToCsv(p);
    const lines = csv.split("\n").filter((l) => l.trim().length > 0).slice(1);
    const colIdx = ATTRIBUTION_CSV_COLUMNS.indexOf("is_top_cost");
    for (const line of lines) {
      const cols = line.split(",");
      expect(["true", "false"]).toContain(cols[colIdx]);
    }
  });

  test("each data row has correct column count", () => {
    const spans = seq([
      { tool: "read", costMillicents: 1000 },
      { tool: "edit", costMillicents: 2000 },
    ]);
    const p = computeSessionAttribution("s", spans);
    const csv = attributionToCsv(p);
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const cols = line.split(",");
      expect(cols).toHaveLength(ATTRIBUTION_CSV_COLUMNS.length);
    }
  });
});

// ── 7. Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("empty spans returns zero totals and empty toolCalls", () => {
    const p = computeSessionAttribution("s", []);
    expect(p.toolCalls).toHaveLength(0);
    expect(p.totalCostUsd).toBe(0);
    expect(p.totalTokens).toBe(0);
    expect(p.topCostCalls).toHaveLength(0);
    expect(p.efficiencyOutliers).toHaveLength(0);
  });

  test("single span: full attribution with one entry", () => {
    const p = computeSessionAttribution("session-abc", [
      span({ tool: "edit", costMillicents: 4200 }),
    ]);
    expect(p.sessionId).toBe("session-abc");
    expect(p.toolCalls).toHaveLength(1);
    expect(p.toolCalls[0].isTopCost).toBe(true);
    expect(p.totalCostUsd).toBeCloseTo(4200 / 100_000, 8);
  });

  test("toolCalls are ordered chronologically (ascending ts)", () => {
    // Provide spans out of order to ensure sort is applied
    const s1 = span({ tool: "bash", costMillicents: 500, ts: new Date(BASE_TS + 2000).toISOString() });
    const s0 = span({ tool: "read", costMillicents: 1000, ts: new Date(BASE_TS).toISOString() });
    const s2 = span({ tool: "edit", costMillicents: 2000, ts: new Date(BASE_TS + 1000).toISOString() });
    const p = computeSessionAttribution("s", [s1, s0, s2]);
    const tools = p.toolCalls.map((c) => c.tool);
    expect(tools).toEqual(["read", "edit", "bash"]);
  });

  test("tokens_reasoning is counted in tokensOut", () => {
    const s = span({ tool: "edit", costMillicents: 1000 });
    s.tokens_output = 50;
    s.tokens_reasoning = 30;
    const p = computeSessionAttribution("s", [s]);
    expect(p.toolCalls[0].tokensOut).toBe(80); // 50 + 30
    expect(p.toolCalls[0].totalTokens).toBe(100 + 80); // tokensIn + tokensOut
  });
});
