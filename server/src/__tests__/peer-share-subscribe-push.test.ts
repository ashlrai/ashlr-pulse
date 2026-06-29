/**
 * peer-share-subscribe-push.test.ts
 *
 * E2E-style unit tests for the peer-share subscribe-push broadcast layer.
 *
 * Covers:
 *   1.  buildAggregateDelta assembles the correct shape with all fields.
 *   2.  signAggregateDelta / verifyAggregateDelta — valid HMAC round-trip.
 *   3.  verifyAggregateDelta rejects a tampered payload.
 *   4.  verifyAggregateDelta rejects a tampered sig.
 *   5.  Privacy: by_model omitted when "model" not in grantFields.
 *   6.  Privacy: by_source omitted when "source" not in grantFields.
 *   7.  Privacy: by_language omitted when "language" not in grantFields.
 *   8.  Privacy: duration_ms omitted when "duration_ms" not in grantFields.
 *   9.  Privacy: no email-like strings appear in the delta payload.
 *  10.  Privacy: forbidden content keys never appear in delta.
 *  11.  broadcastPeerShareAggregate delivers to a mock server (2xx → ok).
 *  12.  broadcastPeerShareAggregate does NOT retry on 4xx.
 *  13.  broadcastPeerShareAggregate retries on 5xx (up to MAX_RETRIES).
 *  14.  broadcastPeerShareAggregate attaches x-pulse-signature header.
 *  15.  Idempotency: same aggregate inputs → same signed payload shape
 *       (seq increments but content fields are stable).
 *  16.  Sequence numbers increment monotonically across aggregate deltas.
 *  17.  SHAREABLE_FIELDS subset: only whitelisted fields in delta payload.
 *  18.  buildAggregateDelta with empty breakdowns produces minimal payload.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildAggregateDelta,
  signAggregateDelta,
  verifyAggregateDelta,
  broadcastPeerShareAggregate,
  resetGrantDeltaSeq,
  clearGrantDeltaRegistry,
  type PeerShareAggregateDelta,
} from "../lib/peer-share-realtime";
import { SHAREABLE_FIELDS } from "../lib/peer-share-guard";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ALICE_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID     = "bbbbbbbb-0000-0000-0000-000000000002";
const CHARLIE_ID = "cccccccc-0000-0000-0000-000000000003";

const BUCKET_HOURLY = "2026-06-17T14:00:00.000Z";
const BUCKET_WEEKLY = "2026-06-15"; // Monday

const GRANT_FIELDS_FULL = [
  "cost_millicents", "tokens_input", "tokens_output",
  "model", "source", "language", "duration_ms",
];

const GRANT_FIELDS_MINIMAL = ["cost_millicents", "tokens_input", "tokens_output"];

const TOTALS = {
  cost_millicents: 123456,
  tokens_input:    10000,
  tokens_output:   5000,
  event_count:     42,
  duration_ms:     99000,
};

const BY_MODEL = {
  "claude-3-7-sonnet-20250219": { cost_millicents: 80000, tokens_input: 7000, tokens_output: 3000 },
  "claude-opus-4-5":            { cost_millicents: 43456, tokens_input: 3000, tokens_output: 2000 },
};

const BY_SOURCE = {
  "cursor":  { cost_millicents: 100000, tokens_input: 8000, tokens_output: 4000 },
  "ashlr":   { cost_millicents: 23456,  tokens_input: 2000, tokens_output: 1000 },
};

const BY_LANGUAGE = {
  "typescript": { cost_millicents: 90000, event_count: 30 },
  "python":     { cost_millicents: 33456, event_count: 12 },
};

beforeEach(() => {
  clearGrantDeltaRegistry();
  resetGrantDeltaSeq();
  // Ensure test signing key fallback is used (not production error).
  // Cast needed because NODE_ENV is typed as read-only in strict mode;
  // this matches the pattern used in peer-share-subscribe.test.ts.
  (process.env as Record<string, string>)["NODE_ENV"] = "test";
});

// ---------------------------------------------------------------------------
// 1. buildAggregateDelta assembles correct shape
// ---------------------------------------------------------------------------

describe("buildAggregateDelta — shape", () => {
  test("1. assembles correct fields with full grant", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS,
      { by_model: BY_MODEL, by_source: BY_SOURCE, by_language: BY_LANGUAGE },
      GRANT_FIELDS_FULL,
    );

    expect(delta.granularity).toBe("hourly");
    expect(delta.owner_id).toBe(ALICE_ID);
    expect(delta.viewer_id).toBe(BOB_ID);
    expect(delta.bucket_start).toBe(BUCKET_HOURLY);
    expect(delta.cost_millicents).toBe(123456);
    expect(delta.tokens_input).toBe(10000);
    expect(delta.tokens_output).toBe(5000);
    expect(delta.event_count).toBe(42);
    expect(delta.duration_ms).toBe(99000);
    expect(delta.by_model).toEqual(BY_MODEL);
    expect(delta.by_source).toEqual(BY_SOURCE);
    expect(delta.by_language).toEqual(BY_LANGUAGE);
    expect(delta.seq).toBeGreaterThan(0);
    expect(delta.ts).toBeTruthy();
    expect(delta.sig).toBeTruthy();
  });

  test("18. minimal payload with empty breakdowns", () => {
    const delta = buildAggregateDelta(
      "weekly", ALICE_ID, BOB_ID, BUCKET_WEEKLY,
      { cost_millicents: 0, tokens_input: 0, tokens_output: 0, event_count: 0 },
      {},
      GRANT_FIELDS_MINIMAL,
    );

    expect(delta.cost_millicents).toBe(0);
    expect(delta.by_model).toBeUndefined();
    expect(delta.by_source).toBeUndefined();
    expect(delta.by_language).toBeUndefined();
    expect(delta.duration_ms).toBeUndefined();
    expect(delta.sig).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2-4. HMAC signing + verification
// ---------------------------------------------------------------------------

describe("HMAC-SHA256 aggregate signing", () => {
  test("2. signAggregateDelta / verifyAggregateDelta — valid round-trip", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, { by_model: BY_MODEL }, GRANT_FIELDS_FULL,
    );
    expect(verifyAggregateDelta(delta)).toBe(true);
  });

  test("3. tampered cost_millicents fails verification", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );
    const tampered: PeerShareAggregateDelta = { ...delta, cost_millicents: delta.cost_millicents + 1 };
    expect(verifyAggregateDelta(tampered)).toBe(false);
  });

  test("4. tampered sig fails verification", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );
    const tampered: PeerShareAggregateDelta = { ...delta, sig: "not-a-valid-sig" };
    expect(verifyAggregateDelta(tampered)).toBe(false);
  });

  test("tampered owner_id fails verification", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );
    const tampered: PeerShareAggregateDelta = { ...delta, owner_id: CHARLIE_ID };
    expect(verifyAggregateDelta(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5-8. Privacy — field gating
// ---------------------------------------------------------------------------

describe("Privacy — field gating", () => {
  test("5. by_model omitted when 'model' not in grantFields", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS,
      { by_model: BY_MODEL, by_source: BY_SOURCE },
      ["cost_millicents", "tokens_input", "source"], // no "model"
    );
    expect(delta.by_model).toBeUndefined();
    expect(delta.by_source).toEqual(BY_SOURCE); // "source" is in fields
  });

  test("6. by_source omitted when 'source' not in grantFields", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS,
      { by_model: BY_MODEL, by_source: BY_SOURCE },
      ["cost_millicents", "tokens_input", "model"], // no "source"
    );
    expect(delta.by_source).toBeUndefined();
    expect(delta.by_model).toEqual(BY_MODEL);
  });

  test("7. by_language omitted when 'language' not in grantFields", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS,
      { by_language: BY_LANGUAGE },
      ["cost_millicents", "tokens_input"], // no "language"
    );
    expect(delta.by_language).toBeUndefined();
  });

  test("8. duration_ms omitted when 'duration_ms' not in grantFields", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, ["cost_millicents"], // no "duration_ms"
    );
    expect(delta.duration_ms).toBeUndefined();
  });

  test("8b. duration_ms included when 'duration_ms' in grantFields", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      { ...TOTALS, duration_ms: 5000 }, {}, ["cost_millicents", "duration_ms"],
    );
    expect(delta.duration_ms).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 9-10. Privacy — no email, no forbidden keys
// ---------------------------------------------------------------------------

describe("Privacy — no email or forbidden content", () => {
  test("9. no email-like strings in aggregate delta", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, { by_model: BY_MODEL, by_source: BY_SOURCE, by_language: BY_LANGUAGE },
      GRANT_FIELDS_FULL,
    );
    const serialized = JSON.stringify(delta);
    expect(serialized).not.toContain("@");
    expect(delta.owner_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(delta.viewer_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("10. forbidden content keys never appear in delta", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, { by_model: BY_MODEL },
      GRANT_FIELDS_FULL,
    );
    const keys = Object.keys(delta);
    const forbidden = [
      "prompt", "prompts", "completion", "completions",
      "code", "content", "diff", "patch", "raw_otel_span",
      "owner_email", "viewer_email", "file_content",
    ];
    for (const key of forbidden) {
      expect(keys).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 11-14. broadcastPeerShareAggregate — HTTP delivery
// ---------------------------------------------------------------------------

describe("broadcastPeerShareAggregate — HTTP delivery", () => {
  /**
   * Build a mock fetch that returns the given responses in order.
   * Returns [mockFetch, capturedRequests[]] for inspection.
   */
  function makeMockFetch(responses: Array<{ status: number; ok: boolean }>) {
    const captured: { url: string; body: string; headers: Record<string, string> }[] = [];
    let callIndex = 0;

    const mockFetch = async (url: string, init?: RequestInit) => {
      captured.push({
        url: url as string,
        body: init?.body as string ?? "",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>)
        ),
      });
      const response = responses[Math.min(callIndex++, responses.length - 1)];
      return {
        ok: response.ok,
        status: response.status,
      } as Response;
    };

    return { mockFetch, captured };
  }

  test("11. delivers to a mock server (200 → ok)", async () => {
    const { mockFetch, captured } = makeMockFetch([{ status: 200, ok: true }]);

    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );

    // Patch global fetch for this test.
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await broadcastPeerShareAggregate(
        "https://example.com/webhook",
        delta,
        "test-secret",
      );
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.attempt).toBe(1);
      expect(captured).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("12. does NOT retry on 4xx", async () => {
    const { mockFetch, captured } = makeMockFetch([
      { status: 403, ok: false },
    ]);

    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      const result = await broadcastPeerShareAggregate(
        "https://example.com/webhook",
        delta,
        null,
      );
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
      // Only 1 attempt — no retry on 4xx.
      expect(captured).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("13. retries on 5xx up to 3 attempts", async () => {
    const { mockFetch, captured } = makeMockFetch([
      { status: 500, ok: false },
      { status: 503, ok: false },
      { status: 500, ok: false },
    ]);

    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Suppress internal backoff sleeps in tests by mocking setTimeout.
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;

    try {
      const result = await broadcastPeerShareAggregate(
        "https://example.com/webhook",
        delta,
        null,
      );
      expect(result.ok).toBe(false);
      // Should have attempted all 3.
      expect(captured).toHaveLength(3);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test("14. attaches x-pulse-signature header when secret provided", async () => {
    const { mockFetch, captured } = makeMockFetch([{ status: 200, ok: true }]);

    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, {}, GRANT_FIELDS_MINIMAL,
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await broadcastPeerShareAggregate(
        "https://example.com/webhook",
        delta,
        "my-hmac-secret",
      );
      const req = captured[0];
      expect(req.headers["x-pulse-signature"]).toBeTruthy();
      expect(req.headers["x-pulse-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(req.headers["x-pulse-event"]).toBe("peer_share_aggregate");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("signed payload body is valid JSON that parses back to the delta", async () => {
    const { mockFetch, captured } = makeMockFetch([{ status: 200, ok: true }]);

    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, { by_model: BY_MODEL }, GRANT_FIELDS_FULL,
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    try {
      await broadcastPeerShareAggregate("https://example.com/webhook", delta, "s");
      const parsed = JSON.parse(captured[0].body) as PeerShareAggregateDelta;
      expect(parsed.owner_id).toBe(ALICE_ID);
      expect(parsed.viewer_id).toBe(BOB_ID);
      expect(parsed.cost_millicents).toBe(TOTALS.cost_millicents);
      // Verify sig still valid on the parsed object.
      expect(verifyAggregateDelta(parsed)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 15-16. Idempotency and sequence monotonicity
// ---------------------------------------------------------------------------

describe("Sequence numbers and idempotency", () => {
  test("16. seq increments monotonically across multiple buildAggregateDelta calls", () => {
    const d1 = buildAggregateDelta("hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY, TOTALS, {}, GRANT_FIELDS_MINIMAL);
    const d2 = buildAggregateDelta("hourly", ALICE_ID, CHARLIE_ID, BUCKET_HOURLY, TOTALS, {}, GRANT_FIELDS_MINIMAL);
    const d3 = buildAggregateDelta("weekly", ALICE_ID, BOB_ID, BUCKET_WEEKLY, TOTALS, {}, GRANT_FIELDS_MINIMAL);

    expect(d2.seq).toBeGreaterThan(d1.seq);
    expect(d3.seq).toBeGreaterThan(d2.seq);
  });

  test("15. same aggregate inputs produce same content fields (seq/ts differ)", () => {
    const d1 = buildAggregateDelta("hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY, TOTALS, {}, GRANT_FIELDS_MINIMAL);
    const d2 = buildAggregateDelta("hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY, TOTALS, {}, GRANT_FIELDS_MINIMAL);

    // Content fields are stable.
    expect(d1.cost_millicents).toBe(d2.cost_millicents);
    expect(d1.tokens_input).toBe(d2.tokens_input);
    expect(d1.tokens_output).toBe(d2.tokens_output);
    expect(d1.event_count).toBe(d2.event_count);
    expect(d1.owner_id).toBe(d2.owner_id);
    expect(d1.viewer_id).toBe(d2.viewer_id);
    expect(d1.bucket_start).toBe(d2.bucket_start);
    expect(d1.granularity).toBe(d2.granularity);

    // Sequence and timestamp differ (as expected for separate calls).
    expect(d2.seq).toBeGreaterThan(d1.seq);

    // Each individual delta verifies against its own sig.
    expect(verifyAggregateDelta(d1)).toBe(true);
    expect(verifyAggregateDelta(d2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. SHAREABLE_FIELDS integrity — by_model values contain only safe fields
// ---------------------------------------------------------------------------

describe("SHAREABLE_FIELDS integrity", () => {
  test("17. by_model keys in delta are model names from SHAREABLE_FIELDS-compliant grant", () => {
    const delta = buildAggregateDelta(
      "hourly", ALICE_ID, BOB_ID, BUCKET_HOURLY,
      TOTALS, { by_model: BY_MODEL }, ["cost_millicents", "tokens_input", "tokens_output", "model"],
    );

    // Verify "model" is in SHAREABLE_FIELDS.
    expect(SHAREABLE_FIELDS.has("model")).toBe(true);
    expect(SHAREABLE_FIELDS.has("cost_millicents")).toBe(true);
    expect(SHAREABLE_FIELDS.has("tokens_input")).toBe(true);
    expect(SHAREABLE_FIELDS.has("tokens_output")).toBe(true);

    // by_model is present and each entry has only numeric aggregate fields.
    expect(delta.by_model).toBeDefined();
    for (const [, v] of Object.entries(delta.by_model!)) {
      expect(typeof v.cost_millicents).toBe("number");
      expect(typeof v.tokens_input).toBe("number");
      expect(typeof v.tokens_output).toBe("number");
      // No forbidden keys.
      const keys = Object.keys(v);
      expect(keys).not.toContain("prompt");
      expect(keys).not.toContain("completion");
      expect(keys).not.toContain("raw_otel_span");
    }
  });

  test("signAggregateDelta is consistent for identical inputs", () => {
    const sig1 = signAggregateDelta(
      1, "2026-06-17T14:00:00.000Z", "hourly",
      ALICE_ID, BOB_ID, BUCKET_HOURLY,
      123456, 10000, 5000, 42,
    );
    const sig2 = signAggregateDelta(
      1, "2026-06-17T14:00:00.000Z", "hourly",
      ALICE_ID, BOB_ID, BUCKET_HOURLY,
      123456, 10000, 5000, 42,
    );
    expect(sig1).toBe(sig2);
  });
});
