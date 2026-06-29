/**
 * fleet-scorecard-webhook.test.ts
 *
 * Tests for the fleet scorecard webhook sink — pure-function unit tests
 * for event evaluation, HMAC signing, payload shape, and privacy floor.
 *
 * All tests are pure (no DB, no network). deliverWebhook is tested with a
 * mock fetch that records calls and simulates success/retry/4xx scenarios.
 *
 * Test inventory:
 *   1. evaluateWebhookEvents — each event condition, edge cases, empty events
 *   2. signPayload — HMAC-SHA256 format, determinism, different secrets
 *   3. buildMetricsSnapshot — privacy floor (no forbidden fields)
 *   4. deliverWebhook — successful delivery, 4xx no-retry, 5xx retry + backoff,
 *      HMAC header present/absent, correct payload structure
 *   5. Payload privacy floor — serialized payload never contains forbidden keys
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { createHmac } from "crypto";

import {
  evaluateWebhookEvents,
  signPayload,
  buildMetricsSnapshot,
  deliverWebhook,
  QUALITY_ALERT_APPROVAL_THRESHOLD,
  STALE_REVIEW_THRESHOLD,
  type MetricsSnapshot,
  type WebhookPayload,
  type FiredEvent,
} from "../src/lib/fleet-scorecard-webhook";

import type { FleetMetrics } from "../src/lib/fleet-oversight";
import type { WebhookEventSlug } from "../src/lib/webhook-db";

// ---------------------------------------------------------------------------
// Synthetic builders
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<FleetMetrics> = {}): FleetMetrics {
  return {
    window: {
      start: "2026-06-28T00:00:00.000Z",
      end: "2026-06-29T00:00:00.000Z",
      days: 1,
    },
    productivity: {
      proposals: 10,
      perDay: 10,
      ticks: 50,
      activeAgents: 2,
      reposTouched: 3,
      costUsd: 5.0,
      costPerProposal: 0.5,
      appliedChanges: 8,
    },
    quality: {
      applied: 8,
      rejected: 2,
      pending: 0,
      resolved: 10,
      approvalRate: 0.8,
      rejectionRate: 0.2,
      avgHoursToReview: 1.5,
      staleReviewCount: 0,
    },
    impact: {
      reposImproved: 2,
      reposRegressed: 0,
      avgHealthScore: 80,
    },
    safety: {
      spendUsd: 5.0,
      budgetCapUsd: 50,
      overBudget: false,
      failedCommands: 0,
    },
    byEngine: [],
    byRepo: [],
    byOwner: [],
    trend: "flat",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    proposals: 10,
    applied: 8,
    rejected: 2,
    pending: 0,
    approval_rate: 0.8,
    rejection_rate: 0.2,
    cost_usd: 5.0,
    active_agents: 2,
    repos_touched: 3,
    stale_review_count: 0,
    failed_commands: 0,
    spend_usd: 5.0,
    budget_cap_usd: 50,
    over_budget: false,
    trend: "flat",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. evaluateWebhookEvents
// ---------------------------------------------------------------------------

describe("evaluateWebhookEvents — fleet_quality_alert", () => {
  test("does not fire when approval_rate >= threshold", () => {
    const snap = makeSnapshot({ approval_rate: 0.8, applied: 8, rejected: 2 });
    const fired = evaluateWebhookEvents(snap, ["fleet_quality_alert"]);
    expect(fired).toHaveLength(0);
  });

  test("fires when approval_rate < threshold and enough resolved proposals", () => {
    const snap = makeSnapshot({ approval_rate: 0.5, applied: 5, rejected: 5 });
    const fired = evaluateWebhookEvents(snap, ["fleet_quality_alert"]);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toBe("fleet_quality_alert");
    expect(fired[0].threshold).toBe(QUALITY_ALERT_APPROVAL_THRESHOLD);
    expect(fired[0].actual).toBe(0.5);
  });

  test("does NOT fire when resolved count < 3 (avoid false positives on empty windows)", () => {
    // Only 2 resolved (1 applied + 1 rejected) — not enough signal
    const snap = makeSnapshot({ approval_rate: 0.5, applied: 1, rejected: 1 });
    const fired = evaluateWebhookEvents(snap, ["fleet_quality_alert"]);
    expect(fired).toHaveLength(0);
  });

  test("fires at exactly MIN_RESOLVED_FOR_QUALITY resolved (boundary)", () => {
    // 1 applied + 2 rejected = 3 resolved, approval_rate = 0.33 < 0.8
    const snap = makeSnapshot({ approval_rate: 0.33, applied: 1, rejected: 2 });
    const fired = evaluateWebhookEvents(snap, ["fleet_quality_alert"]);
    expect(fired).toHaveLength(1);
  });
});

describe("evaluateWebhookEvents — budget_exceeded", () => {
  test("does not fire when not over budget", () => {
    const snap = makeSnapshot({ over_budget: false, budget_cap_usd: 50, spend_usd: 30 });
    const fired = evaluateWebhookEvents(snap, ["budget_exceeded"]);
    expect(fired).toHaveLength(0);
  });

  test("fires when over_budget is true", () => {
    const snap = makeSnapshot({ over_budget: true, budget_cap_usd: 50, spend_usd: 55 });
    const fired = evaluateWebhookEvents(snap, ["budget_exceeded"]);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toBe("budget_exceeded");
    expect(fired[0].threshold).toBe(50);
    expect(fired[0].actual).toBe(55);
  });

  test("does not fire when over_budget but budget_cap_usd is null (no cap set)", () => {
    // over_budget=true should only fire when cap is configured
    const snap = makeSnapshot({ over_budget: true, budget_cap_usd: null, spend_usd: 55 });
    const fired = evaluateWebhookEvents(snap, ["budget_exceeded"]);
    expect(fired).toHaveLength(0);
  });
});

describe("evaluateWebhookEvents — stale_review", () => {
  test("does not fire below threshold", () => {
    const snap = makeSnapshot({ stale_review_count: 4 });
    const fired = evaluateWebhookEvents(snap, ["stale_review"]);
    expect(fired).toHaveLength(0);
  });

  test("fires at exactly the threshold (boundary)", () => {
    const snap = makeSnapshot({ stale_review_count: STALE_REVIEW_THRESHOLD });
    const fired = evaluateWebhookEvents(snap, ["stale_review"]);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toBe("stale_review");
    expect(fired[0].actual).toBe(STALE_REVIEW_THRESHOLD);
  });

  test("fires above threshold", () => {
    const snap = makeSnapshot({ stale_review_count: 10 });
    const fired = evaluateWebhookEvents(snap, ["stale_review"]);
    expect(fired).toHaveLength(1);
  });
});

describe("evaluateWebhookEvents — agent_down", () => {
  test("does not fire when active_agents > 0", () => {
    const snap = makeSnapshot({ active_agents: 2, proposals: 5 });
    const fired = evaluateWebhookEvents(snap, ["agent_down"]);
    expect(fired).toHaveLength(0);
  });

  test("does not fire when active_agents=0 AND proposals=0 (fleet was never active)", () => {
    const snap = makeSnapshot({ active_agents: 0, proposals: 0 });
    const fired = evaluateWebhookEvents(snap, ["agent_down"]);
    expect(fired).toHaveLength(0);
  });

  test("fires when active_agents=0 but proposals > 0 (fleet went dark)", () => {
    const snap = makeSnapshot({ active_agents: 0, proposals: 5 });
    const fired = evaluateWebhookEvents(snap, ["agent_down"]);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toBe("agent_down");
    expect(fired[0].actual).toBe(0);
    expect(fired[0].threshold).toBe(1);
  });
});

describe("evaluateWebhookEvents — multi-event", () => {
  test("returns empty array when no events subscribed", () => {
    const snap = makeSnapshot({ over_budget: true, budget_cap_usd: 50, spend_usd: 60 });
    expect(evaluateWebhookEvents(snap, [])).toHaveLength(0);
  });

  test("only fires subscribed events even if other conditions met", () => {
    // budget exceeded AND approval_rate low AND stale_reviews, but only budget subscribed
    const snap = makeSnapshot({
      over_budget: true,
      budget_cap_usd: 50,
      spend_usd: 60,
      approval_rate: 0.5,
      applied: 3,
      rejected: 3,
      stale_review_count: 10,
    });
    const fired = evaluateWebhookEvents(snap, ["budget_exceeded"]);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toBe("budget_exceeded");
  });

  test("fires multiple events when all conditions met and all subscribed", () => {
    const snap = makeSnapshot({
      over_budget: true,
      budget_cap_usd: 50,
      spend_usd: 60,
      approval_rate: 0.5,
      applied: 3,
      rejected: 3,
      stale_review_count: 10,
    });
    const fired = evaluateWebhookEvents(snap, [
      "fleet_quality_alert",
      "budget_exceeded",
      "stale_review",
    ]);
    expect(fired).toHaveLength(3);
    const events = fired.map((f) => f.event);
    expect(events).toContain("fleet_quality_alert");
    expect(events).toContain("budget_exceeded");
    expect(events).toContain("stale_review");
  });
});

// ---------------------------------------------------------------------------
// 2. signPayload
// ---------------------------------------------------------------------------

describe("signPayload", () => {
  test("returns sha256=<hex> format", () => {
    const sig = signPayload("mysecret", '{"hello":"world"}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("is deterministic for the same secret+body", () => {
    const body = '{"event":"fleet_quality_alert"}';
    const sig1 = signPayload("secret123", body);
    const sig2 = signPayload("secret123", body);
    expect(sig1).toBe(sig2);
  });

  test("differs for different secrets", () => {
    const body = '{"event":"budget_exceeded"}';
    expect(signPayload("secret-a", body)).not.toBe(signPayload("secret-b", body));
  });

  test("differs for different bodies", () => {
    const secret = "shared-secret";
    expect(signPayload(secret, '{"a":1}')).not.toBe(signPayload(secret, '{"a":2}'));
  });

  test("matches manual HMAC-SHA256 computation", () => {
    const secret = "test-signing-secret";
    const body = '{"event":"stale_review","org_id":"org-xyz"}';
    const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(signPayload(secret, body)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 3. buildMetricsSnapshot — privacy floor
// ---------------------------------------------------------------------------

describe("buildMetricsSnapshot — privacy floor", () => {
  const FORBIDDEN_FIELDS = [
    "prompt", "completion", "diff", "patch", "file_content", "code",
    "message", "content", "repo_name", "file_path", "commit_message",
  ];

  test("snapshot contains only metadata fields — no forbidden content keys", () => {
    const metrics = makeMetrics();
    const snapshot = buildMetricsSnapshot(metrics);
    const serialized = JSON.stringify(snapshot).toLowerCase();

    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("snapshot is structurally complete — all expected keys present", () => {
    const metrics = makeMetrics();
    const snapshot = buildMetricsSnapshot(metrics);
    const keys = Object.keys(snapshot);

    const expected = [
      "proposals", "applied", "rejected", "pending",
      "approval_rate", "rejection_rate",
      "cost_usd", "active_agents", "repos_touched",
      "stale_review_count", "failed_commands",
      "spend_usd", "budget_cap_usd", "over_budget", "trend",
    ];
    for (const k of expected) {
      expect(keys).toContain(k);
    }
  });

  test("snapshot does NOT include byRepo, byEngine, or byOwner breakdowns", () => {
    const metrics = makeMetrics({
      byRepo: [{ repo: "acme/secret-repo", proposals: 5, approvalRate: 0.8, costUsd: 1.0, healthScore: null }],
      byEngine: [{ engine: "claude", proposals: 5, approvalRate: 0.8, costUsd: 1.0 }],
      byOwner: [{ owner: "user-uuid", proposals: 5, approvalRate: 0.8 }],
    });
    const snapshot = buildMetricsSnapshot(metrics);
    const keys = Object.keys(snapshot);
    expect(keys).not.toContain("byRepo");
    expect(keys).not.toContain("byEngine");
    expect(keys).not.toContain("byOwner");
    // Also check serialized form doesn't leak repo names
    expect(JSON.stringify(snapshot)).not.toContain("acme/secret-repo");
  });

  test("all numeric fields in snapshot are finite numbers", () => {
    const snapshot = buildMetricsSnapshot(makeMetrics());
    const numericFields: (keyof MetricsSnapshot)[] = [
      "proposals", "applied", "rejected", "pending",
      "approval_rate", "rejection_rate", "cost_usd",
      "active_agents", "repos_touched", "stale_review_count",
      "failed_commands", "spend_usd",
    ];
    for (const f of numericFields) {
      expect(Number.isFinite(snapshot[f] as number)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. deliverWebhook — mock fetch
// ---------------------------------------------------------------------------

// Capture fetch calls for inspection.
type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchResponses: Array<Response | Error> = [];

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  fetchCalls.push({ url: url.toString(), init: init ?? {} });
  const next = fetchResponses.shift();
  if (!next) return Promise.resolve(new Response(null, { status: 200 }));
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}

function makePayload(event: WebhookEventSlug = "fleet_quality_alert"): WebhookPayload {
  return {
    event,
    org_id: "org-test-123",
    window: { start: "2026-06-28T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z", days: 1 },
    metrics_snapshot: makeSnapshot(),
    threshold: 0.8,
    actual: 0.5,
    triggered_at: "2026-06-29T02:30:00.000Z",
  };
}

// Replace global fetch with our mock for the duration of these tests.
// Bun supports overriding globalThis.fetch directly in tests.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  // @ts-expect-error — overriding for test purposes
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deliverWebhook — successful delivery", () => {
  test("returns ok:true on 200 response", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(true);
    expect((result as { status: number }).status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
  });

  test("POSTs to correct URL with correct content-type", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    await deliverWebhook("https://hooks.slack.com/test", makePayload(), null);
    expect(fetchCalls[0].url).toBe("https://hooks.slack.com/test");
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  test("body is valid JSON containing the payload", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    const payload = makePayload("budget_exceeded");
    await deliverWebhook("https://example.com/hook", payload, null);
    const body = fetchCalls[0].init.body as string;
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe("budget_exceeded");
    expect(parsed.org_id).toBe("org-test-123");
    expect(parsed.metrics_snapshot).toBeDefined();
    expect(parsed.triggered_at).toBe("2026-06-29T02:30:00.000Z");
  });

  test("includes x-pulse-event header", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    await deliverWebhook("https://example.com/hook", makePayload("stale_review"), null);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["x-pulse-event"]).toBe("stale_review");
  });
});

describe("deliverWebhook — HMAC signing", () => {
  test("includes x-pulse-signature header when secret provided", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    const payload = makePayload();
    const secret = "my-webhook-secret-abc";
    await deliverWebhook("https://example.com/hook", payload, secret);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["x-pulse-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("signature matches manual HMAC-SHA256 computation", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    const payload = makePayload();
    const secret = "verify-me-please";
    await deliverWebhook("https://example.com/hook", payload, secret);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    const body = fetchCalls[0].init.body as string;
    const expected = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(headers["x-pulse-signature"]).toBe(expected);
  });

  test("does NOT include x-pulse-signature when secret is null", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    await deliverWebhook("https://example.com/hook", makePayload(), null);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["x-pulse-signature"]).toBeUndefined();
  });
});

describe("deliverWebhook — 4xx no retry", () => {
  test("returns ok:false immediately on 400 without retrying", async () => {
    fetchResponses.push(new Response(null, { status: 400 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(400);
    // Should not have retried
    expect(fetchCalls).toHaveLength(1);
  });

  test("returns ok:false on 403 without retrying", async () => {
    fetchResponses.push(new Response(null, { status: 403 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(false);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("deliverWebhook — 5xx retry", () => {
  test("retries on 500 and succeeds on second attempt", async () => {
    fetchResponses.push(new Response(null, { status: 500 }));
    fetchResponses.push(new Response(null, { status: 200 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(true);
    expect((result as { attempt: number }).attempt).toBe(2);
    expect(fetchCalls).toHaveLength(2);
  });

  test("retries up to MAX_RETRIES (3) on consecutive 500s", async () => {
    fetchResponses.push(new Response(null, { status: 503 }));
    fetchResponses.push(new Response(null, { status: 503 }));
    fetchResponses.push(new Response(null, { status: 503 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(false);
    expect(fetchCalls).toHaveLength(3);
  });

  test("returns ok:false with last status after all retries exhausted", async () => {
    fetchResponses.push(new Response(null, { status: 502 }));
    fetchResponses.push(new Response(null, { status: 502 }));
    fetchResponses.push(new Response(null, { status: 502 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(false);
    expect((result as { status: number | null }).status).toBe(502);
  });

  test("retries on network error and succeeds on second attempt", async () => {
    fetchResponses.push(new Error("connect ECONNREFUSED"));
    fetchResponses.push(new Response(null, { status: 200 }));
    const result = await deliverWebhook("https://example.com/hook", makePayload(), null);
    expect(result.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Full payload privacy floor — end-to-end serialization check
// ---------------------------------------------------------------------------

describe("WebhookPayload — privacy floor", () => {
  const FORBIDDEN_PAYLOAD_FIELDS = [
    "prompt", "completion", "diff", "patch", "file_content",
    "code", "commit_message", "file_path",
  ];

  test("serialized payload never contains forbidden content fields", () => {
    const payload: WebhookPayload = {
      event: "fleet_quality_alert",
      org_id: "org-abc",
      window: { start: "2026-06-28T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z", days: 1 },
      metrics_snapshot: makeSnapshot(),
      threshold: 0.8,
      actual: 0.7,
      triggered_at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const forbidden of FORBIDDEN_PAYLOAD_FIELDS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("payload contains all required top-level fields", () => {
    const payload: WebhookPayload = {
      event: "budget_exceeded",
      org_id: "org-xyz",
      window: { start: "2026-06-28T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z", days: 1 },
      metrics_snapshot: makeSnapshot(),
      threshold: 50,
      actual: 55.3,
      triggered_at: new Date().toISOString(),
    };
    const keys = Object.keys(payload);
    for (const required of ["event", "org_id", "window", "metrics_snapshot", "threshold", "actual", "triggered_at"]) {
      expect(keys).toContain(required);
    }
  });

  test("metrics_snapshot in payload never leaks byRepo or byEngine breakdowns", async () => {
    fetchResponses.push(new Response(null, { status: 200 }));
    const payload = makePayload();
    await deliverWebhook("https://example.com/hook", payload, null);
    const body = fetchCalls[0].init.body as string;
    expect(body).not.toContain("byRepo");
    expect(body).not.toContain("byEngine");
    expect(body).not.toContain("byOwner");
  });
});
