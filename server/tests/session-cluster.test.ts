/**
 * Tests for session-cluster.ts.
 *
 * Validates:
 *   - chain detection (read→edit→bash→read→edit → 3-phase pattern)
 *   - latency ordering in toolChain
 *   - cost rollup correctness
 *   - session isolation (multiple session ids)
 *   - unknown session id bucketing
 *   - non-claude_code sources are excluded
 *   - empty input
 *   - avgTokensPerMs calculation
 */

import { describe, expect, test } from "bun:test";
import {
  clusterSpansBySession,
  type SpanRow,
} from "../src/lib/session-cluster";

// ── Helpers ──────────────────────────────────────────────────────────────────

function span(overrides: Partial<SpanRow> & { tool: string }): SpanRow {
  const { tool, tool_calls_types: toolTypesOverride, ...rest } = overrides;
  return {
    session_id: "sess-a",
    ts: new Date(Date.now() - 60_000).toISOString(),
    duration_ms: 500,
    // Use caller's tool_calls_types if provided, otherwise derive from tool.
    tool_calls_types: toolTypesOverride ?? [tool],
    tokens_input: 100,
    tokens_output: 50,
    tokens_reasoning: null,
    cost_millicents: 1000, // 1000 millicents = 1 cent
    repo_name: "my/repo",
    source: "claude_code",
    model: "claude-sonnet-4-6",
    // Spread remaining overrides last so callers can override any field above.
    ...rest,
  };
}

function seq(tools: string[], sessionId = "sess-a"): SpanRow[] {
  const base = Date.now() - tools.length * 1000;
  return tools.map((tool, i) =>
    span({
      tool,
      session_id: sessionId,
      ts: new Date(base + i * 1000).toISOString(),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("clusterSpansBySession", () => {
  test("empty input returns empty array", () => {
    expect(clusterSpansBySession([])).toEqual([]);
  });

  test("excludes non-agent sources", () => {
    const spans: SpanRow[] = [
      span({ tool: "bash", source: "git" }),
      span({ tool: "bash", source: "shell" }),
      span({ tool: "bash", source: "ashlr-fleet" }),
    ];
    expect(clusterSpansBySession(spans)).toEqual([]);
  });

  test("includes ashlr_plugin source", () => {
    const spans: SpanRow[] = [span({ tool: "read", source: "ashlr_plugin" })];
    const clusters = clusterSpansBySession(spans);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].spanCount).toBe(1);
  });

  test("groups spans by session_id", () => {
    const spans: SpanRow[] = [
      ...seq(["read", "edit"], "sess-a"),
      ...seq(["bash", "read"], "sess-b"),
    ];
    const clusters = clusterSpansBySession(spans);
    expect(clusters).toHaveLength(2);
    const ids = clusters.map((c) => c.sessionId).sort();
    expect(ids).toEqual(["sess-a", "sess-b"]);
  });

  test("null session_id goes into __unknown__ bucket", () => {
    const spans: SpanRow[] = [
      { ...span({ tool: "read" }), session_id: null },
    ];
    const clusters = clusterSpansBySession(spans);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sessionId).toBe("__unknown__");
  });

  test("detects read→edit→bash as refactor chain", () => {
    const clusters = clusterSpansBySession(seq(["read", "edit", "bash"]));
    expect(clusters).toHaveLength(1);
    const phases = clusters[0].phases;
    expect(phases.some((p) => p.name === "refactor chain")).toBe(true);
  });

  test("read→edit→bash→read→edit produces at least 2 phases", () => {
    // read→edit→bash = refactor chain; then read→edit = write chain
    const clusters = clusterSpansBySession(
      seq(["read", "edit", "bash", "read", "edit"]),
    );
    expect(clusters[0].phases.length).toBeGreaterThanOrEqual(2);
  });

  test("toolChain has one entry per span", () => {
    const tools = ["read", "edit", "bash", "read"];
    const clusters = clusterSpansBySession(seq(tools));
    expect(clusters[0].toolChain).toHaveLength(tools.length);
  });

  test("toolChain is sorted chronologically (not by latency)", () => {
    // Spans with varying duration — toolChain should preserve time order.
    const base = Date.now() - 10_000;
    const spans: SpanRow[] = [
      span({ tool: "read",  ts: new Date(base).toISOString(),         duration_ms: 100 }),
      span({ tool: "edit",  ts: new Date(base + 1000).toISOString(),  duration_ms: 3000 }),
      span({ tool: "bash",  ts: new Date(base + 2000).toISOString(),  duration_ms: 50 }),
    ];
    const clusters = clusterSpansBySession(spans);
    const tools = clusters[0].toolChain.map((c) => c.tool);
    expect(tools).toEqual(["read", "edit", "bash"]);
  });

  test("cost rollup: totalCost is sum of individual span costs", () => {
    // Each span has cost_millicents = 1000 (= 1 cent = 100 in USD cents? No:
    // millicentsToUsdCents = Number(mc) / 1000, so 1000mc = 1.0 USD cents)
    const spans = seq(["read", "edit", "bash"]);
    // Each span: cost_millicents = 1000 → 1000/1000 = 1.0 cent
    const clusters = clusterSpansBySession(spans);
    expect(clusters[0].totalCost).toBeCloseTo(3.0, 4); // 3 spans × 1 cent
  });

  test("totalLatency is sum of duration_ms", () => {
    const base = Date.now() - 5000;
    const spans: SpanRow[] = [
      span({ tool: "read", ts: new Date(base).toISOString(),        duration_ms: 200 }),
      span({ tool: "edit", ts: new Date(base + 1000).toISOString(), duration_ms: 300 }),
      span({ tool: "bash", ts: new Date(base + 2000).toISOString(), duration_ms: 500 }),
    ];
    const clusters = clusterSpansBySession(spans);
    expect(clusters[0].totalLatency).toBe(1000);
  });

  test("avgTokensPerMs = totalTokens / totalLatency", () => {
    const base = Date.now() - 5000;
    const spans: SpanRow[] = [
      span({
        tool: "read",
        ts: new Date(base).toISOString(),
        duration_ms: 1000,
        tokens_input: 100,
        tokens_output: 50,
      }),
    ];
    const clusters = clusterSpansBySession(spans);
    const c = clusters[0];
    expect(c.totalTokens).toBe(150);
    expect(c.avgTokensPerMs).toBeCloseTo(150 / 1000, 5);
  });

  test("avgTokensPerMs is 0 when totalLatency is 0", () => {
    const spans: SpanRow[] = [span({ tool: "read", duration_ms: 0 })];
    const clusters = clusterSpansBySession(spans);
    expect(clusters[0].avgTokensPerMs).toBe(0);
  });

  test("sorted by totalCost descending", () => {
    const base = Date.now() - 10_000;
    const spansA: SpanRow[] = [
      span({ tool: "read", session_id: "cheap", ts: new Date(base).toISOString(),       cost_millicents: 100 }),
    ];
    const spansB: SpanRow[] = [
      span({ tool: "edit", session_id: "expensive", ts: new Date(base + 100).toISOString(), cost_millicents: 9000 }),
    ];
    const clusters = clusterSpansBySession([...spansA, ...spansB]);
    expect(clusters[0].sessionId).toBe("expensive");
    expect(clusters[1].sessionId).toBe("cheap");
  });

  test("repo is most common repo_name across spans", () => {
    const base = Date.now() - 5000;
    const spans: SpanRow[] = [
      span({ tool: "read", ts: new Date(base).toISOString(),        repo_name: "a/b" }),
      span({ tool: "edit", ts: new Date(base + 1000).toISOString(), repo_name: "a/b" }),
      span({ tool: "bash", ts: new Date(base + 2000).toISOString(), repo_name: "c/d" }),
    ];
    const clusters = clusterSpansBySession(spans);
    expect(clusters[0].repo).toBe("a/b");
  });

  test("phase totalCost is sum of calls in that phase", () => {
    // read→edit→bash = refactor chain, each call costs 1 cent
    const clusters = clusterSpansBySession(seq(["read", "edit", "bash"]));
    const rfPhase = clusters[0].phases.find((p) => p.name === "refactor chain")!;
    expect(rfPhase).toBeDefined();
    expect(rfPhase.totalCost).toBeCloseTo(3.0, 4);
    expect(rfPhase.totalLatencyMs).toBe(3 * 500); // each span has duration_ms=500
  });

  test("detects read-validate loop (read→bash→read)", () => {
    const clusters = clusterSpansBySession(seq(["read", "bash", "read"]));
    const phase = clusters[0].phases.find((p) => p.name === "read-validate loop");
    expect(phase).toBeDefined();
  });

  test("no phases when sequence has no matching pattern", () => {
    const clusters = clusterSpansBySession(seq(["bash", "bash", "bash"]));
    expect(clusters[0].phases).toHaveLength(0);
  });
});
