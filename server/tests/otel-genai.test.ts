/**
 * otel-genai.test.ts — pure-function tests for the span mapper.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

import { spanToActivityEvent } from "../src/lib/otel-genai";
import type { OtlpSpan, OtlpTracesPayload } from "../src/lib/otlp-types";

const FIXTURE_PATH = resolve(import.meta.dir, "..", "..", "research", "example-span.json");

function loadFixtureSpan(): OtlpSpan {
  const payload = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as OtlpTracesPayload;
  const span = payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
  if (!span) throw new Error("fixture missing span");
  return span;
}

describe("spanToActivityEvent", () => {
  it("maps a Claude Code GenAI span to a full row", () => {
    const row = spanToActivityEvent(loadFixtureSpan(), "mason");
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe("mason");
    expect(row!.provider).toBe("anthropic");
    expect(row!.source).toBe("claude_code");
    expect(row!.model).toBe("claude-opus-4-7");
    expect(row!.tokens_input).toBe(1280);
    expect(row!.tokens_output).toBe(640);
    expect(row!.tokens_cache_read).toBe(8192);
    expect(row!.tool_calls_count).toBe(3);
    expect(row!.tool_calls_types).toEqual(["bash", "read", "edit"]);
    expect(row!.repo_name).toBe("ashlrai/ashlr-plugin");
    expect(row!.git_branch).toBe("main");
    expect(row!.language).toBe("typescript");
    expect(row!.session_id).toBe("sess-abc-1");
    expect(row!.duration_ms).toBe(1500);
    // ts derived from 1713827400000000000 ns → 1713827400000 ms → an ISO
    // string in the expected year. Assert shape rather than exact value so
    // the test isn't tied to timezone-locale quirks of `Date.toISOString`.
    expect(row!.ts).toMatch(/^2024-04-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row!.raw_otel_span).toBeDefined();
  });

  it("returns null for a non-GenAI span", () => {
    const row = spanToActivityEvent(
      {
        name: "GET /",
        attributes: [
          { key: "http.method", value: { stringValue: "GET" } },
          { key: "http.target", value: { stringValue: "/" } },
        ],
      },
      "mason",
    );
    expect(row).toBeNull();
  });

  it("tolerates partial attributes (cursor / copilot shape)", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        startTimeUnixNano: "1713827400000000000",
        endTimeUnixNano:   "1713827400500000000",
        attributes: [
          { key: "gen_ai.system",              value: { stringValue: "openai" } },
          { key: "gen_ai.request.model",       value: { stringValue: "gpt-4o" } },
          { key: "gen_ai.usage.input_tokens",  value: { intValue: "100" } },
          { key: "gen_ai.usage.output_tokens", value: { intValue: "50" } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe("openai");     // no claude.* attrs → falls back to provider
    expect(row!.provider).toBe("openai");
    expect(row!.model).toBe("gpt-4o");
    expect(row!.tool_calls_count).toBeNull();
    expect(row!.repo_name).toBeNull();
    expect(row!.duration_ms).toBe(500);
  });

  it("recognizes ashlr-plugin spans and surfaces tokens_saved", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        startTimeUnixNano: "1714000000000000000",
        endTimeUnixNano:   "1714000001000000000",
        attributes: [
          { key: "gen_ai.system",              value: { stringValue: "anthropic" } },
          { key: "gen_ai.request.model",       value: { stringValue: "claude-opus-4-7" } },
          { key: "gen_ai.usage.input_tokens",  value: { intValue: 800 } },
          { key: "gen_ai.usage.output_tokens", value: { intValue: 200 } },
          { key: "ashlr.plugin.tokens_saved",  value: { intValue: 1240 } },
          { key: "ashlr.plugin.session_id",    value: { stringValue: "plugin-sess-1" } },
          { key: "ashlr.plugin.repo",          value: { stringValue: "ashlrai/pulse" } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe("ashlr_plugin");
    expect(row!.tokens_saved).toBe(1240);
    expect(row!.session_id).toBe("plugin-sess-1");
    expect(row!.repo_name).toBe("ashlrai/pulse");
    expect(row!.duration_ms).toBe(1000);
  });

  it("ashlr-plugin source label wins over claude.* attributes", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        attributes: [
          { key: "gen_ai.system",            value: { stringValue: "anthropic" } },
          { key: "claude.session.id",        value: { stringValue: "claude-sess" } },
          { key: "ashlr.plugin.tokens_saved", value: { intValue: 50 } },
        ],
      },
      "mason",
    );
    expect(row!.source).toBe("ashlr_plugin");
    // Falls through to claude.session.id when plugin doesn't supply its own.
    expect(row!.session_id).toBe("claude-sess");
  });

  it("skips malformed tokens gracefully", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        attributes: [
          { key: "gen_ai.system",              value: { stringValue: "anthropic" } },
          { key: "gen_ai.usage.input_tokens",  value: { stringValue: "not-a-number" as unknown as string } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.tokens_input).toBeNull();
  });

  it("maps gen_ai.usage.reasoning_tokens to tokens_reasoning", () => {
    // 2026-04-01 in nanoseconds — Opus 4.7's price entry is effective
    // 2026-01-01 so the lookup must succeed. (An earlier ts would return
    // null cost because no price ladder covers it.)
    const ts2026 = "1775337600000000000";
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        startTimeUnixNano: ts2026,
        endTimeUnixNano:   "1775337600500000000",
        attributes: [
          { key: "gen_ai.system",                value: { stringValue: "anthropic" } },
          { key: "gen_ai.request.model",         value: { stringValue: "claude-opus-4-7" } },
          { key: "gen_ai.usage.input_tokens",    value: { intValue: 100 } },
          { key: "gen_ai.usage.output_tokens",   value: { intValue: 50 } },
          { key: "gen_ai.usage.reasoning_tokens", value: { intValue: 8000 } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.tokens_reasoning).toBe(8000);
    // 100 in × $5/M + 50 out × $25/M + 8000 reasoning × $25/M
    // = 0.0005 + 0.00125 + 0.20 = 0.20175 → 20175 millicents (rounded)
    expect(row!.cost_millicents).not.toBeNull();
    expect(row!.cost_millicents!).toBeGreaterThan(20000);
    expect(row!.cost_millicents!).toBeLessThan(21000);
    expect(row!.pricing_version).toBeGreaterThan(0);
  });

  it("maps ashlr-plugin per-feature savings into JSONB breakdown", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        attributes: [
          { key: "gen_ai.system",                    value: { stringValue: "anthropic" } },
          { key: "gen_ai.request.model",             value: { stringValue: "claude-opus-4-7" } },
          { key: "ashlr.plugin.tokens_saved",        value: { intValue: 1500 } },
          { key: "ashlr.plugin.savings.genome",      value: { intValue: 1000 } },
          { key: "ashlr.plugin.savings.snipcompact", value: { intValue: 400 } },
          { key: "ashlr.plugin.savings.route",       value: { intValue: 100 } },
          { key: "ashlr.plugin.feature_flags",       value: { stringValue: "genome,snipcompact,route" } },
          { key: "ashlr.plugin.version",             value: { stringValue: "0.7.0" } },
          { key: "ashlr.plugin.genome_hit_rate",     value: { doubleValue: 0.83 } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.tokens_saved).toBe(1500);
    expect(row!.tokens_saved_breakdown).toEqual({ genome: 1000, snipcompact: 400, route: 100 });
    expect(row!.plugin_features).toEqual(["genome", "snipcompact", "route"]);
    expect(row!.plugin_version).toBe("0.7.0");
    expect(row!.plugin_genome_hit_rate).toBeCloseTo(0.83, 5);
  });

  it("plugin breakdown stays null when no per-feature attrs are present", () => {
    const row = spanToActivityEvent(
      {
        name: "gen_ai.request",
        attributes: [
          { key: "gen_ai.system", value: { stringValue: "anthropic" } },
          { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-7" } },
          { key: "ashlr.plugin.tokens_saved", value: { intValue: 50 } },
        ],
      },
      "mason",
    );
    expect(row!.tokens_saved_breakdown).toBeNull();
    expect(row!.plugin_features).toBeNull();
    expect(row!.plugin_version).toBeNull();
  });

  it("dedup_key is identical for two spans with the same content", () => {
    const make = (): Parameters<typeof spanToActivityEvent>[0] => ({
      name: "gen_ai.request",
      startTimeUnixNano: "1714300000000000000",
      endTimeUnixNano:   "1714300000500000000",
      attributes: [
        { key: "gen_ai.system",              value: { stringValue: "anthropic" } },
        { key: "gen_ai.request.model",       value: { stringValue: "claude-opus-4-7" } },
        { key: "gen_ai.usage.input_tokens",  value: { intValue: 250 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 80 } },
        { key: "claude.repo.name",           value: { stringValue: "ashlrai/timeline" } },
      ],
    });
    const a = spanToActivityEvent(make(), "mason");
    const b = spanToActivityEvent(make(), "mason");
    expect(a!.dedup_key).toBe(b!.dedup_key);
    expect(a!.dedup_key).not.toBeNull();
  });

  it("cmux: different span_ids AND different session_ids → same dedup_key when content matches", () => {
    // cmux mints a fresh session_id per shell, so two parallel
    // instances tailing the same logical work don't share session_id.
    // The dedup_key formula must collapse them on content alone — if
    // it included session_id the duplicates would slip through (this
    // is what 0017 hit in production; 0018 reverted to content-only).
    const make = (spanId: string, sessionId: string): Parameters<typeof spanToActivityEvent>[0] => ({
      name: "gen_ai.request",
      spanId,
      startTimeUnixNano: "1714400000000000000",
      endTimeUnixNano:   "1714400000500000000",
      attributes: [
        { key: "gen_ai.system",              value: { stringValue: "anthropic" } },
        { key: "gen_ai.request.model",       value: { stringValue: "claude-opus-4-7" } },
        { key: "gen_ai.usage.input_tokens",  value: { intValue: 1500 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 200 } },
        { key: "claude.session.id",          value: { stringValue: sessionId } },
        { key: "claude.repo.name",           value: { stringValue: "ashlrai/timeline" } },
      ],
    });
    const a = spanToActivityEvent(make("aaaa11112222", "sess-cmux-1"), "mason");
    const b = spanToActivityEvent(make("bbbb33334444", "sess-cmux-2"), "mason");
    expect(a!.span_id).not.toBe(b!.span_id);
    expect(a!.session_id).not.toBe(b!.session_id);
    expect(a!.dedup_key).toBe(b!.dedup_key);
  });

  it("distinct sessions with different cache patterns get different dedup_keys", () => {
    // Token columns (cache_read, cache_5m, cache_1h) provide enough
    // specificity that genuinely distinct sessions diverge — even if
    // input/output happen to match.
    const make = (cacheRead: number): Parameters<typeof spanToActivityEvent>[0] => ({
      name: "gen_ai.request",
      startTimeUnixNano: "1714400000000000000",
      endTimeUnixNano:   "1714400000500000000",
      attributes: [
        { key: "gen_ai.system",                value: { stringValue: "anthropic" } },
        { key: "gen_ai.request.model",         value: { stringValue: "claude-opus-4-7" } },
        { key: "gen_ai.usage.input_tokens",    value: { intValue: 1500 } },
        { key: "gen_ai.usage.output_tokens",   value: { intValue: 200 } },
        { key: "gen_ai.usage.cache_read_tokens", value: { intValue: cacheRead } },
      ],
    });
    const a = spanToActivityEvent(make(50_000), "mason");
    const b = spanToActivityEvent(make(80_000), "mason");
    expect(a!.dedup_key).not.toBe(b!.dedup_key);
  });

  it("dedup_key differs when token counts differ", () => {
    const base: Parameters<typeof spanToActivityEvent>[0] = {
      name: "gen_ai.request",
      startTimeUnixNano: "1714300000000000000",
      endTimeUnixNano:   "1714300000500000000",
      attributes: [
        { key: "gen_ai.system",              value: { stringValue: "anthropic" } },
        { key: "gen_ai.request.model",       value: { stringValue: "claude-opus-4-7" } },
        { key: "gen_ai.usage.input_tokens",  value: { intValue: 250 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 80 } },
      ],
    };
    const a = spanToActivityEvent(base, "mason");
    const variant = JSON.parse(JSON.stringify(base)) as typeof base;
    variant.attributes![2].value = { intValue: 999 };
    const b = spanToActivityEvent(variant, "mason");
    expect(a!.dedup_key).not.toBe(b!.dedup_key);
  });

  it("ashlr.source=git overrides the derived source label", () => {
    // The pulse-agent emits git-commit spans with gen_ai.system=anthropic (to
    // pass the GenAI-shape gate) plus ashlr.source=git so the UI can show
    // them distinctly from Claude Code activity spans.
    const row = spanToActivityEvent(
      {
        name: "git.commit",
        startTimeUnixNano: "1714100000000000000",
        endTimeUnixNano:   "1714100000000000000",
        attributes: [
          { key: "gen_ai.system",   value: { stringValue: "anthropic" } },
          { key: "ashlr.source",    value: { stringValue: "git" } },
          { key: "claude.repo.name", value: { stringValue: "ashlrai/ashlr-pulse" } },
          { key: "claude.git.branch", value: { stringValue: "main" } },
        ],
      },
      "mason",
    );
    expect(row).not.toBeNull();
    expect(row!.source).toBe("git");
    expect(row!.provider).toBe("anthropic");
    expect(row!.repo_name).toBe("ashlrai/ashlr-pulse");
    expect(row!.duration_ms).toBe(0);
  });
});
