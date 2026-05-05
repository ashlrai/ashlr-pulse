/**
 * dedup-hour-bucket.test.ts — regression test for migration 0019.
 *
 * Migrations 0017→0019 iterated three times on the dedup_key formula:
 *   0015: per-span_id partial unique  → ok for the OTel happy path.
 *   0017: added session_id            → over-discriminated under cmux.
 *   0018: dropped session_id          → twin-emit duplicates with the
 *                                        same content but distinct
 *                                        timestamps still leaked through.
 *   0019: hour-bucket the timestamp   → collapses twin emits within an
 *                                        hour, keeps cross-hour events
 *                                        distinct.
 *
 * The dedup_key derivation lives in `makeDedupKey()` in lib/otel-genai.ts
 * (unexported). We exercise it indirectly via `spanToActivityEvent`,
 * which is the only path that runs in production.
 */

import { describe, expect, test } from "bun:test";
import { spanToActivityEvent } from "../src/lib/otel-genai";
import type { OtlpSpan } from "../src/lib/otlp-types";

/** Build a minimal Claude GenAI span at a specific unix-epoch ns. */
function span(unixNanos: bigint, overrides: Partial<{
  inputTokens: number;
  outputTokens: number;
  model: string;
  repo: string;
}> = {}): OtlpSpan {
  return {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: `b7ad6b71${unixNanos.toString().slice(-8)}`,
    name: "gen_ai.request",
    kind: 3,
    startTimeUnixNano: unixNanos.toString(),
    endTimeUnixNano: (unixNanos + 1_500_000_000n).toString(),
    attributes: [
      { key: "gen_ai.system", value: { stringValue: "anthropic" } },
      { key: "gen_ai.request.model", value: { stringValue: overrides.model ?? "claude-opus-4-7" } },
      { key: "gen_ai.usage.input_tokens",  value: { intValue: String(overrides.inputTokens  ?? 1280) } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: String(overrides.outputTokens ?? 640) } },
      { key: "claude.repo.name", value: { stringValue: overrides.repo ?? "ashlrai/ashlr-plugin" } },
    ],
  } as OtlpSpan;
}

// 2026-05-04T21:00:00.000Z in unix-epoch ns. The hour bucket is "...T21".
const HOUR_START_NS = 1_777_582_800_000_000_000n;
const ONE_SECOND_NS = 1_000_000_000n;
const ONE_HOUR_NS = 3_600_000_000_000_000_000n / 1_000_000_000n * 1_000_000_000n; // = 3600 * 1e9

describe("dedup_key — hour-bucketed content hash", () => {
  test("twin emits 30s apart in the same hour collide", () => {
    // Migration 0019 reproduction: a single Claude turn fires two
    // identical-cost emissions ~30s apart. dedup_key MUST match so the
    // ON CONFLICT DO NOTHING in the ingest route discards the second.
    const a = spanToActivityEvent(span(HOUR_START_NS), "user-1");
    const b = spanToActivityEvent(span(HOUR_START_NS + 30n * ONE_SECOND_NS), "user-1");
    expect(a?.dedup_key).toBeTruthy();
    expect(a?.dedup_key).toBe(b?.dedup_key);
  });

  test("emits 40s apart in same hour collide (cmux worst case)", () => {
    // The migration header documents costs spread over 10–40s — verify
    // the upper bound still collapses.
    const a = spanToActivityEvent(span(HOUR_START_NS + 5n * ONE_SECOND_NS), "user-1");
    const b = spanToActivityEvent(span(HOUR_START_NS + 45n * ONE_SECOND_NS), "user-1");
    expect(a?.dedup_key).toBe(b?.dedup_key);
  });

  test("emits across hour boundary do NOT collide", () => {
    // The hour bucket is intentional; cross-hour identical content is a
    // rare-but-real legitimate event and must not be collapsed.
    const justBefore = HOUR_START_NS + 59n * 60n * ONE_SECOND_NS + 30n * ONE_SECOND_NS;
    const justAfter  = HOUR_START_NS + 60n * 60n * ONE_SECOND_NS + 30n * ONE_SECOND_NS;
    const a = spanToActivityEvent(span(justBefore), "user-1");
    const b = spanToActivityEvent(span(justAfter), "user-1");
    expect(a?.dedup_key).not.toBe(b?.dedup_key);
  });

  test("different users with identical content do NOT collide", () => {
    // dedup_key is content-only but uniqueness is enforced on
    // (user_id, dedup_key) — but the key itself includes user_id so the
    // same content from two users yields two distinct keys (defense in
    // depth).
    const a = spanToActivityEvent(span(HOUR_START_NS), "user-1");
    const b = spanToActivityEvent(span(HOUR_START_NS), "user-2");
    expect(a?.dedup_key).not.toBe(b?.dedup_key);
  });

  test("different token counts in same hour do NOT collide", () => {
    const a = spanToActivityEvent(span(HOUR_START_NS, { inputTokens: 1280 }), "user-1");
    const b = spanToActivityEvent(span(HOUR_START_NS, { inputTokens: 1281 }), "user-1");
    expect(a?.dedup_key).not.toBe(b?.dedup_key);
  });

  test("different repos in same hour do NOT collide", () => {
    const a = spanToActivityEvent(span(HOUR_START_NS, { repo: "ashlrai/ashlr-plugin" }), "user-1");
    const b = spanToActivityEvent(span(HOUR_START_NS, { repo: "ashlrai/ashlr-pulse" }), "user-1");
    expect(a?.dedup_key).not.toBe(b?.dedup_key);
  });

  test("dedup_key is 32 hex chars (the SQL LEFT(...,32) prefix)", () => {
    const a = spanToActivityEvent(span(HOUR_START_NS), "user-1");
    expect(a?.dedup_key).toMatch(/^[0-9a-f]{32}$/);
  });
});
