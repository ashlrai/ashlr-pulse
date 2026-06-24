/**
 * fleet-ingest.test.ts — otel-genai mapper tests for ashlr-fleet spans.
 *
 * Validates the ingest contract described in the task:
 *   span.name:  fleet.tick | fleet.proposal | fleet.merge | fleet.decline
 *   attributes: ashlr.source="ashlr-fleet", gen_ai.system=engine,
 *               gen_ai.usage.input_tokens / output_tokens,
 *               ashlr.fleet.event, ashlr.fleet.repo,
 *               ashlr.fleet.outcome, ashlr.fleet.cost_usd,
 *               ashlr.fleet.ref_id
 */

import { describe, it, expect } from "bun:test";

import { spanToActivityEvent } from "../src/lib/otel-genai";

// Helper — build a minimal fleet span with the supplied overrides.
function fleetSpan(
  overrides: Record<string, string | number> = {},
  name = "fleet.proposal",
): Parameters<typeof spanToActivityEvent>[0] {
  const defaults: Record<string, string | number> = {
    "ashlr.source":          "ashlr-fleet",
    "ashlr.fleet.event":     "proposal",
    "ashlr.fleet.repo":      "acme/api",
    "ashlr.fleet.outcome":   "pending",
    "ashlr.fleet.cost_usd":  "0.00042",
    "ashlr.fleet.ref_id":    "ref-abc-123",
    "gen_ai.system":         "claude",
    "gen_ai.usage.input_tokens":  800,
    "gen_ai.usage.output_tokens": 200,
  };

  const merged = { ...defaults, ...overrides };

  return {
    name,
    spanId: "aabbccdd11223344",
    startTimeUnixNano: "1775337600000000000",
    endTimeUnixNano:   "1775337601000000000",
    attributes: Object.entries(merged).map(([key, raw]) => {
      if (typeof raw === "number") return { key, value: { intValue: raw } };
      return { key, value: { stringValue: raw } };
    }),
  };
}

describe("fleet span ingest — source mapping", () => {
  it("maps ashlr.source=ashlr-fleet to source='ashlr-fleet'", () => {
    const row = spanToActivityEvent(fleetSpan(), "mason");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("ashlr-fleet");
  });

  it("passes the hasFleet gate even without gen_ai.* provider attrs", () => {
    // Fleet spans may arrive with only ashlr.fleet.* attrs and no
    // gen_ai.system when the engine is unknown / builtin.
    const row = spanToActivityEvent(
      {
        name: "fleet.tick",
        spanId: "aabbccdd00000001",
        startTimeUnixNano: "1775337600000000000",
        endTimeUnixNano:   "1775337600100000000",
        attributes: [
          { key: "ashlr.source",        value: { stringValue: "ashlr-fleet" } },
          { key: "ashlr.fleet.event",   value: { stringValue: "tick" } },
          { key: "ashlr.fleet.outcome", value: { stringValue: "idle" } },
          { key: "ashlr.fleet.repo",    value: { stringValue: "acme/core" } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe("ashlr-fleet");
    expect(row!.fleet_event).toBe("tick");
    expect(row!.fleet_outcome).toBe("idle");
  });
});

describe("fleet span ingest — fleet_event / fleet_outcome columns", () => {
  it("maps ashlr.fleet.event=proposal → fleet_event='proposal'", () => {
    const row = spanToActivityEvent(fleetSpan({ "ashlr.fleet.event": "proposal" }, "fleet.proposal"), "mason");
    expect(row!.fleet_event).toBe("proposal");
  });

  it("maps ashlr.fleet.event=merge → fleet_event='merge'", () => {
    const row = spanToActivityEvent(
      fleetSpan({ "ashlr.fleet.event": "merge", "ashlr.fleet.outcome": "applied" }, "fleet.merge"),
      "mason",
    );
    expect(row!.fleet_event).toBe("merge");
    expect(row!.fleet_outcome).toBe("applied");
  });

  it("maps ashlr.fleet.event=decline → fleet_event='decline'", () => {
    const row = spanToActivityEvent(
      fleetSpan({ "ashlr.fleet.event": "decline", "ashlr.fleet.outcome": "rejected" }, "fleet.decline"),
      "mason",
    );
    expect(row!.fleet_event).toBe("decline");
    expect(row!.fleet_outcome).toBe("rejected");
  });

  it("maps ashlr.fleet.event=tick with tick-reason outcome", () => {
    const row = spanToActivityEvent(
      fleetSpan({ "ashlr.fleet.event": "tick", "ashlr.fleet.outcome": "no-changes" }, "fleet.tick"),
      "mason",
    );
    expect(row!.fleet_event).toBe("tick");
    expect(row!.fleet_outcome).toBe("no-changes");
  });

  it("leaves fleet_event/fleet_outcome null for non-fleet spans", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        attributes: [
          { key: "gen_ai.system",             value: { stringValue: "anthropic" } },
          { key: "gen_ai.usage.input_tokens",  value: { intValue: 100 } },
          { key: "gen_ai.usage.output_tokens", value: { intValue: 50 } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.fleet_event).toBeNull();
    expect(row!.fleet_outcome).toBeNull();
  });
});

describe("fleet span ingest — repo + engine mapping", () => {
  it("maps ashlr.fleet.repo to repo_name", () => {
    const row = spanToActivityEvent(fleetSpan({ "ashlr.fleet.repo": "myorg/backend" }), "mason");
    expect(row!.repo_name).toBe("myorg/backend");
  });

  it("maps gen_ai.system to provider (engine label)", () => {
    const row = spanToActivityEvent(fleetSpan({ "gen_ai.system": "codex" }), "mason");
    expect(row!.provider).toBe("codex");
  });

  it("maps gen_ai.system=builtin to provider='builtin'", () => {
    const row = spanToActivityEvent(fleetSpan({ "gen_ai.system": "builtin" }), "mason");
    expect(row!.provider).toBe("builtin");
  });
});

describe("fleet span ingest — token fields", () => {
  it("maps gen_ai.usage.input_tokens and output_tokens", () => {
    const row = spanToActivityEvent(
      fleetSpan({ "gen_ai.usage.input_tokens": 1500, "gen_ai.usage.output_tokens": 300 }),
      "mason",
    );
    expect(row!.tokens_input).toBe(1500);
    expect(row!.tokens_output).toBe(300);
  });

  it("leaves tokens null when absent", () => {
    const row = spanToActivityEvent(
      {
        name: "fleet.tick",
        attributes: [
          { key: "ashlr.source",        value: { stringValue: "ashlr-fleet" } },
          { key: "ashlr.fleet.event",   value: { stringValue: "tick" } },
          { key: "ashlr.fleet.outcome", value: { stringValue: "ok" } },
        ],
      },
      "mason",
    );
    expect(row!.tokens_input).toBeNull();
    expect(row!.tokens_output).toBeNull();
  });
});

describe("fleet span ingest — cost_usd fallback", () => {
  it("parses ashlr.fleet.cost_usd into millicents when no token-based cost exists", () => {
    // Span has no gen_ai.system model → costMillicents() returns null →
    // falls back to fleetCostMillicents derived from cost_usd.
    const row = spanToActivityEvent(
      {
        name: "fleet.merge",
        spanId: "aabbccdd00000099",
        startTimeUnixNano: "1775337600000000000",
        endTimeUnixNano:   "1775337600500000000",
        attributes: [
          { key: "ashlr.source",          value: { stringValue: "ashlr-fleet" } },
          { key: "ashlr.fleet.event",     value: { stringValue: "merge" } },
          { key: "ashlr.fleet.outcome",   value: { stringValue: "applied" } },
          { key: "ashlr.fleet.repo",      value: { stringValue: "acme/api" } },
          { key: "ashlr.fleet.cost_usd",  value: { stringValue: "0.00042" } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    // 0.00042 USD × 100_000 millicents/USD = 42 millicents (rounded)
    expect(row!.cost_millicents).toBe(42);
  });

  it("prefers computed token-based cost over fleet.cost_usd when model is known", () => {
    // When gen_ai.request.model is a known model, costMillicents() succeeds
    // and should take precedence over the supplied cost_usd.
    const row = spanToActivityEvent(
      fleetSpan({
        "gen_ai.request.model":          "claude-opus-4-7",
        "gen_ai.usage.input_tokens":     100,
        "gen_ai.usage.output_tokens":    50,
        "ashlr.fleet.cost_usd":          "9999", // absurdly large — should be ignored
      }),
      "mason",
    );
    // Computed cost should be in the single-digit dollar range, not 9999 USD.
    expect(row!.cost_millicents).not.toBeNull();
    expect(row!.cost_millicents!).toBeLessThan(10_000_000); // < $100
  });
});

describe("fleet span ingest — dedup via span_id", () => {
  it("preserves spanId for the existing (user_id, span_id) dedup path", () => {
    const row = spanToActivityEvent(
      { ...fleetSpan(), spanId: "deadbeef12345678" },
      "mason",
    );
    expect(row!.span_id).toBe("deadbeef12345678");
  });

  it("produces a stable dedup_key for identical fleet events", () => {
    const a = spanToActivityEvent(fleetSpan(), "mason");
    const b = spanToActivityEvent(fleetSpan(), "mason");
    expect(a!.dedup_key).toBe(b!.dedup_key);
    expect(a!.dedup_key).not.toBeNull();
  });

  it("produces distinct dedup_keys for different repos", () => {
    const a = spanToActivityEvent(fleetSpan({ "ashlr.fleet.repo": "acme/api" }),     "mason");
    const b = spanToActivityEvent(fleetSpan({ "ashlr.fleet.repo": "acme/backend" }), "mason");
    expect(a!.dedup_key).not.toBe(b!.dedup_key);
  });
});
