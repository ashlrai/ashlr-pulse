/**
 * cursor-ingest.test.ts
 *
 * Tests for the Cursor IDE usage API ingest module.
 *
 * Sections:
 *   1. inferProvider     — model string → "anthropic" | "openai" | null
 *   2. buildDedupKey     — stable hash for idempotency
 *   3. sessionToActivityEvent — fixture → ActivityEventInsert shape
 *   4. Cost calculation  — matches pricing table expectations
 *   5. Integration       — round-trip DB insert + dedup (requires DATABASE_URL)
 *
 * Run with:
 *   bun test src/__tests__/cursor-ingest.test.ts
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  inferProvider,
  buildDedupKey,
  sessionToActivityEvent,
  type CursorUsageSession,
} from "../lib/cursor-ingest";
import { costMillicents, normalizeModel } from "../lib/pricing";

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeSession(overrides: Partial<CursorUsageSession> = {}): CursorUsageSession {
  return {
    id: "cursor-session-abc123",
    user_id: "cursor-user-001",
    model: "claude-sonnet-4-5",
    tokens_input: 1000,
    tokens_output: 200,
    duration_ms: 5000,
    ts: "2026-06-01T10:00:00Z",
    ...overrides,
  };
}

const PULSE_USER = "pulse-user-uuid-001";

// ── 1. inferProvider ─────────────────────────────────────────────────────────

describe("inferProvider", () => {
  test("claude-* models → anthropic", () => {
    expect(inferProvider("claude-sonnet-4-5")).toBe("anthropic");
    expect(inferProvider("claude-opus-4")).toBe("anthropic");
    expect(inferProvider("claude-haiku-3-5")).toBe("anthropic");
    expect(inferProvider("claude-3-5-sonnet-20241022")).toBe("anthropic");
  });

  test("gpt-* models → openai", () => {
    expect(inferProvider("gpt-4o")).toBe("openai");
    expect(inferProvider("gpt-4o-mini")).toBe("openai");
    expect(inferProvider("gpt-5")).toBe("openai");
    expect(inferProvider("gpt-5-mini")).toBe("openai");
  });

  test("o1/o3/o4 reasoning models → openai", () => {
    expect(inferProvider("o1")).toBe("openai");
    expect(inferProvider("o3")).toBe("openai");
    expect(inferProvider("o4-mini")).toBe("openai");
    expect(inferProvider("o1-preview")).toBe("openai");
  });

  test("unknown model → null", () => {
    expect(inferProvider("gemini-pro")).toBeNull();
    expect(inferProvider("llama-3")).toBeNull();
    expect(inferProvider("mistral-large")).toBeNull();
    expect(inferProvider("")).toBeNull();
  });
});

// ── 2. buildDedupKey ─────────────────────────────────────────────────────────

describe("buildDedupKey", () => {
  test("produces a 64-character hex SHA-256", () => {
    const key = buildDedupKey("sess-1", "user-1", "claude-sonnet-4-5", "2026-06-01T10:00:00Z");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable for the same inputs", () => {
    const a = buildDedupKey("sess-1", "user-1", "gpt-4o", "2026-06-01T10:00:00Z");
    const b = buildDedupKey("sess-1", "user-1", "gpt-4o", "2026-06-01T10:00:00Z");
    expect(a).toBe(b);
  });

  test("matches manual SHA-256 computation", () => {
    const sessionId = "cursor-session-abc123";
    const userId = "cursor-user-001";
    const model = "claude-sonnet-4-5";
    const ts = "2026-06-01T10:00:00Z";
    const tsSecond = ts.slice(0, 19);

    const expected = createHash("sha256")
      .update(`${sessionId}:${userId}:${model}:${tsSecond}`)
      .digest("hex");

    expect(buildDedupKey(sessionId, userId, model, ts)).toBe(expected);
  });

  test("sub-second jitter does not change the key", () => {
    const a = buildDedupKey("s", "u", "gpt-4o", "2026-06-01T10:00:00.000Z");
    const b = buildDedupKey("s", "u", "gpt-4o", "2026-06-01T10:00:00.999Z");
    // Both truncate to "2026-06-01T10:00:00"
    expect(a).toBe(b);
  });

  test("different session IDs produce different keys", () => {
    const a = buildDedupKey("sess-1", "user-1", "gpt-4o", "2026-06-01T10:00:00Z");
    const b = buildDedupKey("sess-2", "user-1", "gpt-4o", "2026-06-01T10:00:00Z");
    expect(a).not.toBe(b);
  });

  test("different users produce different keys", () => {
    const a = buildDedupKey("sess-1", "user-A", "gpt-4o", "2026-06-01T10:00:00Z");
    const b = buildDedupKey("sess-1", "user-B", "gpt-4o", "2026-06-01T10:00:00Z");
    expect(a).not.toBe(b);
  });
});

// ── 3. sessionToActivityEvent ────────────────────────────────────────────────

describe("sessionToActivityEvent — event shape", () => {
  test("source is always 'cursor'", () => {
    const ev = sessionToActivityEvent(makeSession(), PULSE_USER);
    expect(ev.source).toBe("cursor");
  });

  test("provider is 'anthropic' for claude models", () => {
    const ev = sessionToActivityEvent(makeSession({ model: "claude-sonnet-4-5" }), PULSE_USER);
    expect(ev.provider).toBe("anthropic");
  });

  test("provider is 'openai' for gpt models", () => {
    const ev = sessionToActivityEvent(makeSession({ model: "gpt-4o" }), PULSE_USER);
    expect(ev.provider).toBe("openai");
  });

  test("provider is null for unknown models", () => {
    const ev = sessionToActivityEvent(makeSession({ model: "gemini-pro" }), PULSE_USER);
    expect(ev.provider).toBeNull();
  });

  test("user_id is set to pulseUserId", () => {
    const ev = sessionToActivityEvent(makeSession(), PULSE_USER);
    expect(ev.user_id).toBe(PULSE_USER);
  });

  test("ts is ISO-8601 matching session.ts", () => {
    const session = makeSession({ ts: "2026-06-15T08:30:00Z" });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.ts).toBe("2026-06-15T08:30:00.000Z");
  });

  test("token counts are mapped correctly", () => {
    const session = makeSession({ tokens_input: 5000, tokens_output: 1200 });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.tokens_input).toBe(5000);
    expect(ev.tokens_output).toBe(1200);
  });

  test("duration_ms is mapped", () => {
    const ev = sessionToActivityEvent(makeSession({ duration_ms: 12345 }), PULSE_USER);
    expect(ev.duration_ms).toBe(12345);
  });

  test("span_id is null (Cursor doesn't emit OTLP spans)", () => {
    const ev = sessionToActivityEvent(makeSession(), PULSE_USER);
    expect(ev.span_id).toBeNull();
  });

  test("dedup_key and session_id are the same stable hash", () => {
    const ev = sessionToActivityEvent(makeSession(), PULSE_USER);
    expect(ev.dedup_key).toBeTruthy();
    expect(ev.session_id).toBe(ev.dedup_key);
    expect(ev.dedup_key).toHaveLength(64);
  });

  test("privacy floor: code-context fields are null", () => {
    const ev = sessionToActivityEvent(makeSession(), PULSE_USER);
    // These fields must remain null — never store Cursor editor context
    expect(ev.repo_name).toBeNull();
    expect(ev.git_branch).toBeNull();
    expect(ev.project_hash).toBeNull();
    expect(ev.language).toBeNull();
    expect(ev.tool_calls_count).toBeNull();
    expect(ev.tool_calls_types).toBeNull();
    expect(ev.tokens_saved).toBeNull();
    expect(ev.tokens_saved_breakdown).toBeNull();
  });

  test("fleet and codex fields are null for cursor source", () => {
    const ev = sessionToActivityEvent(makeSession(), PULSE_USER);
    expect(ev.fleet_event).toBeNull();
    expect(ev.fleet_outcome).toBeNull();
    expect(ev.fleet_owner).toBeNull();
    expect(ev.codex_plan_type).toBeNull();
    expect(ev.codex_originator).toBeNull();
  });

  test("model is normalised through normalizeModel", () => {
    // Dated form should be normalised
    const session = makeSession({ model: "claude-3-5-sonnet-20241022" });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.model).toBe(normalizeModel("claude-3-5-sonnet-20241022"));
    expect(ev.model).toBe("claude-sonnet-3-5");
  });

  test("re-ingesting same session produces identical dedup_key", () => {
    const session = makeSession();
    const ev1 = sessionToActivityEvent(session, PULSE_USER);
    const ev2 = sessionToActivityEvent(session, PULSE_USER);
    expect(ev1.dedup_key).toBe(ev2.dedup_key);
  });
});

// ── 4. Cost calculation ──────────────────────────────────────────────────────

describe("cost calculation", () => {
  test("claude-sonnet-4-5: known rate → cost_millicents computed correctly", () => {
    // claude-sonnet-4-5: $3/$15 per 1M tokens
    // 1000 input = (1000 * 3) / 10 = 300 mc
    // 200 output = (200 * 15) / 10 = 300 mc
    // total = 600 mc
    const session = makeSession({ model: "claude-sonnet-4-5", tokens_input: 1000, tokens_output: 200 });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.cost_millicents).toBe(600);
    expect(ev.pricing_version).not.toBeNull();
  });

  test("gpt-4o: known rate → cost_millicents computed correctly", () => {
    // gpt-4o: $2.5/$10 per 1M tokens
    // 2000 input = (2000 * 2.5) / 10 = 500 mc
    // 400 output = (400 * 10) / 10 = 400 mc
    // total = 900 mc
    const session = makeSession({ model: "gpt-4o", tokens_input: 2000, tokens_output: 400 });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.cost_millicents).toBe(900);
  });

  test("unknown model → cost_millicents is null, pricing_version is null", () => {
    const session = makeSession({ model: "gemini-future-unknown" });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.cost_millicents).toBeNull();
    expect(ev.pricing_version).toBeNull();
  });

  test("cost matches direct costMillicents() call", () => {
    const session = makeSession({
      model: "claude-opus-4",
      tokens_input: 3000,
      tokens_output: 600,
    });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    const expected = costMillicents({
      model: normalizeModel("claude-opus-4"),
      tokens_input: 3000,
      tokens_output: 600,
      ts: new Date(session.ts),
    });
    expect(ev.cost_millicents).toBe(expected);
  });

  test("zero tokens → cost is 0", () => {
    const session = makeSession({ tokens_input: 0, tokens_output: 0 });
    const ev = sessionToActivityEvent(session, PULSE_USER);
    expect(ev.cost_millicents).toBe(0);
  });

  test("five fixture sessions produce expected total cost", () => {
    const sessions: CursorUsageSession[] = [
      makeSession({ model: "claude-sonnet-4-5", tokens_input: 1000, tokens_output: 200 }), // 600 mc
      makeSession({ id: "s2", model: "claude-sonnet-4-5", tokens_input: 2000, tokens_output: 400 }), // 1200 mc
      makeSession({ id: "s3", model: "gpt-4o",            tokens_input: 1000, tokens_output: 200 }), // 450 mc
      makeSession({ id: "s4", model: "claude-haiku-4-5",  tokens_input: 5000, tokens_output: 1000 }), // 1000 mc
      makeSession({ id: "s5", model: "gpt-4o-mini",       tokens_input: 3000, tokens_output: 600 }), // 81 mc
    ];
    const events = sessions.map((s) => sessionToActivityEvent(s, PULSE_USER));
    const total = events.reduce((sum, ev) => sum + (ev.cost_millicents ?? 0), 0);

    // Verify each individually matches direct pricing call, then sum
    for (const [i, ev] of events.entries()) {
      const s = sessions[i];
      const expected = costMillicents({
        model: normalizeModel(s.model),
        tokens_input: s.tokens_input,
        tokens_output: s.tokens_output,
        ts: new Date(s.ts),
      });
      expect(ev.cost_millicents).toBe(expected);
    }
    // Sum must match sum of individual expected values
    const expectedTotal = sessions.reduce((sum, s) => {
      return sum + (costMillicents({
        model: normalizeModel(s.model),
        tokens_input: s.tokens_input,
        tokens_output: s.tokens_output,
        ts: new Date(s.ts),
      }) ?? 0);
    }, 0);
    expect(total).toBe(expectedTotal);
  });
});

// ── 5. Integration (requires DATABASE_URL) ───────────────────────────────────

const hasDb = !!process.env.DATABASE_URL;

describe("integration: DB round-trip (skipped without DATABASE_URL)", () => {
  test.skipIf(!hasDb)("ingest 5 fixture sessions → correct count in activity_event", async () => {
    const { sql } = await import("../lib/db");
    const { cursorIngest } = await import("../lib/cursor-ingest");
    const { getCursorToken: _getCursorToken } = await import("../lib/cursor-auth");
    const db = sql();

    // Use a deterministic test user_id that won't conflict with real data
    const testUserId = "00000000-0000-0000-0000-cursor-test01";

    // Build 5 sessions with distinct IDs
    const sessions: CursorUsageSession[] = Array.from({ length: 5 }, (_, i) => ({
      id: `integ-session-${i}`,
      user_id: `integ-cursor-user-${i}`,
      model: "claude-sonnet-4-5",
      tokens_input: 1000 * (i + 1),
      tokens_output: 200 * (i + 1),
      duration_ms: 3000 * (i + 1),
      ts: `2026-06-01T${10 + i}:00:00Z`,
    }));

    // Clean up any leftover rows from a previous run
    await db`
      DELETE FROM activity_event
      WHERE user_id = ${testUserId}
        AND source = 'cursor'
        AND session_id LIKE 'integ-session-%'
    `.catch(() => {}); // ignore if table has different session_id type

    // Clean up by dedup_key
    const { buildDedupKey: bdk, sessionToActivityEvent: stoa } = await import("../lib/cursor-ingest");
    const dedupKeys = sessions.map((s) => bdk(s.id, s.user_id, s.model, s.ts));
    await db`
      DELETE FROM activity_event
      WHERE user_id = ${testUserId}
        AND dedup_key = ANY(${dedupKeys})
    `;

    // Map sessions to rows and insert directly (bypasses HTTP layer)
    const rows = sessions.map((s) => stoa(s, testUserId));

    const result = await db`
      INSERT INTO activity_event ${db(rows, [
        "ts", "user_id", "session_id", "source", "provider", "model",
        "duration_ms", "tokens_input", "tokens_output", "tokens_reasoning",
        "tokens_cache_read", "tokens_cache_write", "tokens_cache_5m_write",
        "tokens_cache_1h_write", "tool_calls_count", "tool_calls_types",
        "accepted_count", "rejected_count", "project_hash", "repo_name",
        "git_branch", "language", "tokens_saved", "tokens_saved_breakdown",
        "plugin_features", "plugin_version", "plugin_genome_hit_rate",
        "span_id", "cost_millicents", "pricing_version", "dedup_key",
        "codex_plan_type", "codex_originator", "codex_parent_thread_id",
        "codex_cli_version", "codex_context_window", "codex_rate_limit_primary_pct",
        "codex_rate_limit_secondary_pct", "codex_sandbox_policy", "codex_approval_policy",
        "codex_effort", "fleet_event", "fleet_outcome", "fleet_owner",
      ])}
      ON CONFLICT DO NOTHING
    `;

    expect(result.count).toBe(5);

    // Verify the rows are in the DB
    const [{ n }] = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM activity_event
      WHERE user_id = ${testUserId}
        AND source = 'cursor'
        AND dedup_key = ANY(${dedupKeys})
    `;
    expect(n).toBe(5);

    // Verify idempotency: re-inserting the same rows inserts 0 new rows
    const result2 = await db`
      INSERT INTO activity_event ${db(rows, [
        "ts", "user_id", "session_id", "source", "provider", "model",
        "duration_ms", "tokens_input", "tokens_output", "tokens_reasoning",
        "tokens_cache_read", "tokens_cache_write", "tokens_cache_5m_write",
        "tokens_cache_1h_write", "tool_calls_count", "tool_calls_types",
        "accepted_count", "rejected_count", "project_hash", "repo_name",
        "git_branch", "language", "tokens_saved", "tokens_saved_breakdown",
        "plugin_features", "plugin_version", "plugin_genome_hit_rate",
        "span_id", "cost_millicents", "pricing_version", "dedup_key",
        "codex_plan_type", "codex_originator", "codex_parent_thread_id",
        "codex_cli_version", "codex_context_window", "codex_rate_limit_primary_pct",
        "codex_rate_limit_secondary_pct", "codex_sandbox_policy", "codex_approval_policy",
        "codex_effort", "fleet_event", "fleet_outcome", "fleet_owner",
      ])}
      ON CONFLICT DO NOTHING
    `;
    expect(result2.count).toBe(0); // dedup: no new rows on re-ingest

    // Clean up
    await db`
      DELETE FROM activity_event
      WHERE user_id = ${testUserId}
        AND dedup_key = ANY(${dedupKeys})
    `;
  });
});
