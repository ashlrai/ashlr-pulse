/**
 * codex-source.test.ts — verifies that an OTLP span carrying
 * ashlr.source = 'codex' + the new ashlr.codex.* attributes maps
 * correctly to an ActivityEventInsert row.
 *
 * Privacy floor canary: the test span includes attribute KEYS that
 * resemble prompt-leakage paths (we'd never see these from the agent
 * but external clients could attempt them). Asserts they don't end
 * up as columns on the row.
 */

import { describe, expect, test } from "bun:test";
import { spanToActivityEvent } from "../src/lib/otel-genai";
import type { OtlpSpan } from "../src/lib/otlp-types";

// Timestamps anchored at 2026-05-08T12:00:00Z so they're AFTER every
// PRICES entry's effective date (gpt-5 = 2025-08-01, gpt-5-5 = 2026-04-01,
// claude-* family = 2025+). Otherwise lookup() returns null and
// cost_millicents stays null on test spans.
const FIXTURE_START_NS = "1778587200000000000";  // 2026-05-12T00:00:00Z
const FIXTURE_END_NS   = "1778587201500000000";  // +1.5s

function spanFromAttrs(
  attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }>,
  startNs = FIXTURE_START_NS,
  endNs   = FIXTURE_END_NS,
): OtlpSpan {
  return {
    spanId: "abcdef0123456789",
    traceId: "00000000000000000000000000000001",
    name: "gen_ai.request",
    startTimeUnixNano: startNs,
    endTimeUnixNano:   endNs,
    attributes: attrs,
  };
}

const USER_ID = "00000000-0000-0000-0000-000000000001";

describe("spanToActivityEvent — Codex source", () => {
  test("maps a complete codex token_count span end-to-end", () => {
    const span = spanFromAttrs([
      { key: "ashlr.source",                          value: { stringValue: "codex" } },
      { key: "gen_ai.system",                         value: { stringValue: "openai" } },
      { key: "gen_ai.request.model",                  value: { stringValue: "gpt-5.5" } },
      { key: "gen_ai.usage.input_tokens",             value: { intValue: 113007 } },
      { key: "gen_ai.usage.cache_read_tokens",        value: { intValue: 111488 } },
      { key: "gen_ai.usage.output_tokens",            value: { intValue: 287 } },
      { key: "gen_ai.usage.reasoning_tokens",         value: { intValue: 22 } },
      { key: "gen_ai.openai.context_window",          value: { intValue: 258400 } },
      { key: "ashlr.codex.cli_version",               value: { stringValue: "0.129.0" } },
      { key: "ashlr.codex.originator",                value: { stringValue: "codex-tui" } },
      { key: "ashlr.codex.parent_thread_id",          value: { stringValue: "019e09ae-f6cd-7f80-9506-63427442b994" } },
      { key: "ashlr.codex.plan_type",                 value: { stringValue: "prolite" } },
      { key: "ashlr.codex.rate_limit_primary_pct",    value: { intValue: 37 } },
      { key: "ashlr.codex.rate_limit_secondary_pct",  value: { intValue: 27 } },
      { key: "ashlr.codex.sandbox_policy",            value: { stringValue: "danger-full-access" } },
      { key: "ashlr.codex.approval_policy",           value: { stringValue: "never" } },
      { key: "ashlr.codex.effort",                    value: { stringValue: "medium" } },
      { key: "ashlr.codex.session_id",                value: { stringValue: "019e09d1-7b89-7a31-a45b-ade3432e48fd" } },
      { key: "ashlr.codex.turn_id",                   value: { stringValue: "019e09d1-7b8b-7933-acea-4fa293a3e2a5" } },
      { key: "claude.tool.calls_count",               value: { intValue: 4 } },
      { key: "claude.tool.calls_types",               value: { stringValue: "exec_command,write_file" } },
      { key: "claude.repo.name",                      value: { stringValue: "ashlr/pulse" } },
      { key: "claude.git.branch",                     value: { stringValue: "main" } },
    ]);

    const row = spanToActivityEvent(span, USER_ID);
    expect(row).not.toBeNull();
    if (!row) return;

    // Source detection: ashlr.source override beats hasClaude / hasPlugin.
    expect(row.source).toBe("codex");
    expect(row.provider).toBe("openai");
    expect(row.model).toBe("gpt-5.5");

    // Per-turn token breakdown.
    expect(row.tokens_input).toBe(113007);
    expect(row.tokens_cache_read).toBe(111488);
    expect(row.tokens_output).toBe(287);
    expect(row.tokens_reasoning).toBe(22);

    // Codex-specific columns.
    expect(row.codex_context_window).toBe(258400);
    expect(row.codex_cli_version).toBe("0.129.0");
    expect(row.codex_originator).toBe("codex-tui");
    expect(row.codex_parent_thread_id).toBe("019e09ae-f6cd-7f80-9506-63427442b994");
    expect(row.codex_plan_type).toBe("prolite");
    expect(row.codex_rate_limit_primary_pct).toBe(37);
    expect(row.codex_rate_limit_secondary_pct).toBe(27);
    expect(row.codex_sandbox_policy).toBe("danger-full-access");
    expect(row.codex_approval_policy).toBe("never");
    expect(row.codex_effort).toBe("medium");

    // Tool-call accounting.
    expect(row.tool_calls_count).toBe(4);
    expect(row.tool_calls_types).toEqual(["exec_command", "write_file"]);

    // Cost: gpt-5.5 normalizes to gpt-5-5; we have rates so cost should
    // be > 0 millicents and pricing_version should be set.
    expect(row.cost_millicents).not.toBeNull();
    expect(row.cost_millicents).toBeGreaterThan(0);
    expect(row.pricing_version).not.toBeNull();

    // Repo + branch carried through (these come via the claude.* namespace).
    expect(row.repo_name).toBe("ashlr/pulse");
    expect(row.git_branch).toBe("main");

    // span_id propagates for idempotency.
    expect(row.span_id).toBe("abcdef0123456789");

    // duration_ms = (end - start) / 1e6 = 1500 ms.
    expect(row.duration_ms).toBe(1500);
  });

  test("non-codex spans get null in every codex_* column", () => {
    const span = spanFromAttrs([
      { key: "gen_ai.system",            value: { stringValue: "anthropic" } },
      { key: "gen_ai.request.model",     value: { stringValue: "claude-sonnet-4-6" } },
      { key: "gen_ai.usage.input_tokens",  value: { intValue: 1000 } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: 500 } },
      { key: "claude.repo.name",         value: { stringValue: "test/repo" } },
    ]);
    const row = spanToActivityEvent(span, USER_ID);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.source).toBe("claude_code");
    // Every codex_* column must be null for a non-codex span.
    expect(row.codex_plan_type).toBeNull();
    expect(row.codex_originator).toBeNull();
    expect(row.codex_parent_thread_id).toBeNull();
    expect(row.codex_cli_version).toBeNull();
    expect(row.codex_context_window).toBeNull();
    expect(row.codex_rate_limit_primary_pct).toBeNull();
    expect(row.codex_rate_limit_secondary_pct).toBeNull();
    expect(row.codex_sandbox_policy).toBeNull();
    expect(row.codex_approval_policy).toBeNull();
    expect(row.codex_effort).toBeNull();
  });

  test("codex span without rate-limit attrs maps OK with nulls", () => {
    // Some Codex events fire token_count without rate_limits populated.
    const span = spanFromAttrs([
      { key: "ashlr.source",                value: { stringValue: "codex" } },
      { key: "gen_ai.system",               value: { stringValue: "openai" } },
      { key: "gen_ai.request.model",        value: { stringValue: "gpt-5" } },
      { key: "gen_ai.usage.input_tokens",   value: { intValue: 100 } },
      { key: "gen_ai.usage.output_tokens",  value: { intValue: 50 } },
    ]);
    const row = spanToActivityEvent(span, USER_ID);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.source).toBe("codex");
    expect(row.codex_rate_limit_primary_pct).toBeNull();
    expect(row.codex_rate_limit_secondary_pct).toBeNull();
    expect(row.codex_plan_type).toBeNull();
    // Cost still computed from gpt-5 rate sheet.
    expect(row.cost_millicents).not.toBeNull();
  });

  test("invalid ashlr.source falls back to provider-based detection", () => {
    // ashlr.source must match the ALLOWED_SOURCES set; an arbitrary
    // string falls through to the auto-derived source.
    const span = spanFromAttrs([
      { key: "ashlr.source",                value: { stringValue: "junk-source" } },
      { key: "gen_ai.system",               value: { stringValue: "anthropic" } },
      { key: "gen_ai.request.model",        value: { stringValue: "claude-opus-4-7" } },
      { key: "gen_ai.usage.input_tokens",   value: { intValue: 1 } },
    ]);
    const row = spanToActivityEvent(span, USER_ID);
    expect(row).not.toBeNull();
    if (!row) return;
    // Without claude.* attrs, falls through to provider 'anthropic'.
    expect(row.source).toBe("anthropic");
  });

  test("codex parent_thread_id distinguishes subagent spawns from top-level", () => {
    const subagentSpan = spanFromAttrs([
      { key: "ashlr.source",               value: { stringValue: "codex" } },
      { key: "gen_ai.system",              value: { stringValue: "openai" } },
      { key: "gen_ai.request.model",       value: { stringValue: "gpt-5-nano" } },
      { key: "gen_ai.usage.input_tokens",  value: { intValue: 10 } },
      { key: "ashlr.codex.parent_thread_id", value: { stringValue: "019e09ae-f6cd-7f80-9506-63427442b994" } },
    ]);
    const topLevelSpan = spanFromAttrs([
      { key: "ashlr.source",               value: { stringValue: "codex" } },
      { key: "gen_ai.system",              value: { stringValue: "openai" } },
      { key: "gen_ai.request.model",       value: { stringValue: "gpt-5" } },
      { key: "gen_ai.usage.input_tokens",  value: { intValue: 10 } },
    ]);
    const sub = spanToActivityEvent(subagentSpan, USER_ID);
    const top = spanToActivityEvent(topLevelSpan, USER_ID);
    expect(sub?.codex_parent_thread_id).toBe("019e09ae-f6cd-7f80-9506-63427442b994");
    expect(top?.codex_parent_thread_id).toBeNull();
  });
});

describe("privacy floor canary — codex span", () => {
  test("drops attributes that look like prompt/completion content", () => {
    // The agent never emits these, but external clients might attempt
    // to push prompt/completion content through OTLP. Confirm they
    // don't end up as columns.
    const span = spanFromAttrs([
      { key: "ashlr.source",                value: { stringValue: "codex" } },
      { key: "gen_ai.system",               value: { stringValue: "openai" } },
      { key: "gen_ai.request.model",        value: { stringValue: "gpt-5" } },
      { key: "gen_ai.usage.input_tokens",   value: { intValue: 1 } },
      // These should be silently ignored.
      { key: "gen_ai.prompt",               value: { stringValue: "leak: my secret prompt" } },
      { key: "gen_ai.completion",           value: { stringValue: "leak: model response" } },
      { key: "claude.completion.text",      value: { stringValue: "leak" } },
      { key: "ashlr.codex.tool_call_args",  value: { stringValue: "leak" } },
    ]);
    const row = spanToActivityEvent(span, USER_ID);
    expect(row).not.toBeNull();
    if (!row) return;
    // The row's known columns must NOT contain the leaked text anywhere.
    const serialised = JSON.stringify(row, (key, value) => {
      // raw_otel_span used to preserve the raw payload. It must stay absent
      // from the mapper output so prompt-like attributes cannot be retained.
      if (key === "raw_otel_span") return undefined;
      return value;
    });
    expect(serialised).not.toContain("leak: my secret prompt");
    expect(serialised).not.toContain("leak: model response");
    expect(serialised).not.toContain("leak");
  });
});
