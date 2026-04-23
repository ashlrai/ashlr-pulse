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
});
