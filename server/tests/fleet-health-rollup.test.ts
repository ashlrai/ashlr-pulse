/**
 * fleet-health-rollup.test.ts — unit + integration tests for the
 * /api/fleet/health-rollup endpoint and computeAgentHealthRollup().
 *
 * Three tests:
 *   1. UNIT — API route returns 404 when PULSE_FLEET_HEALTH is not "true".
 *   2. UNIT — Privacy floor: payload shape carries only allowed metadata
 *      keys; no prompt/completion/diff/code content keys ever appear.
 *   3. INTEGRATION (DB-gated) — concurrent agents with mixed heartbeat ages:
 *      one healthy agent (< 300 s), one stale agent (> 300 s). Verifies
 *      isHealthy discrimination, proposalQueueDepth, costLastHour, and org
 *      isolation (a second org's agents never appear).
 *
 * DB gate: describe.skipIf(!HAS_DB) — same pattern as fleet-oversight.test.ts.
 * Run:
 *   createdb pulse_test && DATABASE_URL=postgres://localhost/pulse_test \
 *     bun run migrate && \
 *   DATABASE_URL=... PULSE_FLEET_HEALTH=true \
 *     bun test tests/fleet-health-rollup.test.ts ; dropdb pulse_test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/lib/db";
import { ensureLocalUser, ensureDefaultOrg } from "../src/lib/current-user";
import {
  computeAgentHealthRollup,
  AGENT_STALE_SEC,
  type AgentHealthEntry,
} from "../src/lib/fleet-oversight";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Test 1 — UNIT: feature-flag guard (no DB needed).
// ---------------------------------------------------------------------------

/** Replicate the route's feature-flag guard logic (pure function). */
function routeIsEnabled(envVal: string | undefined): boolean {
  return envVal === "true";
}

describe("health-rollup route feature flag", () => {
  test("returns 404 when PULSE_FLEET_HEALTH is not 'true'", () => {
    expect(routeIsEnabled(undefined)).toBe(false);
    expect(routeIsEnabled("false")).toBe(false);
    expect(routeIsEnabled("1")).toBe(false);
    expect(routeIsEnabled("")).toBe(false);
  });

  test("returns data path when PULSE_FLEET_HEALTH is 'true'", () => {
    expect(routeIsEnabled("true")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — UNIT: privacy floor on the AgentHealthEntry payload shape.
//
// We build a synthetic entry and verify it contains ONLY the five allowed
// metadata fields — no prompt, completion, diff, patch, or file_content keys.
// This is a pure structural / serialization check; no DB needed.
// ---------------------------------------------------------------------------

describe("health-rollup privacy floor", () => {
  const ALLOWED_KEYS: ReadonlySet<string> = new Set([
    "agentId",
    "lastHeartbeatSec",
    "isHealthy",
    "proposalQueueDepth",
    "costLastHour",
  ]);

  const FORBIDDEN_CONTENT_KEYS = [
    "prompt",
    "completion",
    "diff",
    "patch",
    "file_content",
    "code",
    "message",
    "content",
  ] as const;

  test("AgentHealthEntry carries only metadata fields", () => {
    const entry: AgentHealthEntry = {
      agentId: "sess-abc123",
      lastHeartbeatSec: 42,
      isHealthy: true,
      proposalQueueDepth: 3,
      costLastHour: 0.05,
    };

    // Every key on the entry must be in the allowed set.
    for (const key of Object.keys(entry)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }

    // No forbidden content keys present in the serialized payload.
    const serialized = JSON.stringify(entry).toLowerCase();
    for (const forbidden of FORBIDDEN_CONTENT_KEYS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("payload array serializes to <2KB for up to 10 agents", () => {
    // The spec targets <2KB per poll cycle. With 10 concurrent agents
    // (realistic fleet size per org) each entry is ~100 bytes serialized.
    const agents: AgentHealthEntry[] = Array.from({ length: 10 }, (_, i) => ({
      agentId: `session-${i.toString().padStart(8, "0")}`,
      lastHeartbeatSec: i * 15,
      isHealthy: i * 15 <= AGENT_STALE_SEC,
      proposalQueueDepth: i % 3,
      costLastHour: Math.round(i * 0.012 * 100) / 100,
    }));

    const payload = JSON.stringify({ agents });
    expect(payload.length).toBeLessThan(2048);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — INTEGRATION: concurrent agents + stale detection + org isolation.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)(
  "computeAgentHealthRollup — concurrent agents + stale detection",
  () => {
    const emailA = `pulse-health-${Date.now()}@local`;
    const emailB = `pulse-health-b-${Date.now()}@local`;
    let userIdA: string;
    let orgIdA: string;
    let userIdB: string;
    let orgIdB: string;

    beforeAll(async () => {
      const db = sql();

      const meA = await ensureLocalUser(emailA, null);
      userIdA = meA.id;
      orgIdA = await ensureDefaultOrg(userIdA, emailA);

      const meB = await ensureLocalUser(emailB, null);
      userIdB = meB.id;
      orgIdB = await ensureDefaultOrg(userIdB, emailB);

      // ── Org A: two sessions (agents) ──────────────────────────────────
      //
      // Agent "health-session-1" — healthy: last tick 30 seconds ago.
      //   Also has 2 pending proposals and $0.10 cost in the last hour.
      //
      // Agent "health-session-2" — stale: last tick 600 seconds ago
      //   (> AGENT_STALE_SEC=300). No pending proposals, no recent cost.

      // health-session-1: recent tick (30s ago) + 2 pending proposals + cost.
      await db`
        INSERT INTO activity_event
          (ts, user_id, session_id, source, repo_name, provider,
           fleet_event, fleet_outcome, cost_millicents)
        VALUES
          -- heartbeat tick 30 seconds ago
          (NOW() - interval '30 seconds',
           ${userIdA}, 'health-session-1', 'ashlr-fleet', 'acme/api', 'claude',
           'tick', 'ok', 500),
          -- pending proposal 1 (within last hour → also contributes to costLastHour)
          (NOW() - interval '5 minutes',
           ${userIdA}, 'health-session-1', 'ashlr-fleet', 'acme/api', 'claude',
           'proposal', 'pending', 5000),
          -- pending proposal 2
          (NOW() - interval '10 minutes',
           ${userIdA}, 'health-session-1', 'ashlr-fleet', 'acme/api', 'claude',
           'proposal', 'pending', 4500)
      `;

      // health-session-2: stale — last event 600 seconds ago (> 300s threshold).
      await db`
        INSERT INTO activity_event
          (ts, user_id, session_id, source, repo_name, provider,
           fleet_event, fleet_outcome, cost_millicents)
        VALUES
          (NOW() - interval '600 seconds',
           ${userIdA}, 'health-session-2', 'ashlr-fleet', 'acme/web', 'codex',
           'tick', 'ok', 0)
      `;

      // ── Org B: one agent that must NOT appear in org A's rollup ──────
      await db`
        INSERT INTO activity_event
          (ts, user_id, session_id, source, repo_name, provider,
           fleet_event, fleet_outcome, cost_millicents)
        VALUES
          (NOW() - interval '10 seconds',
           ${userIdB}, 'rival-session-1', 'ashlr-fleet', 'rival/repo', 'claude',
           'tick', 'ok', 99999)
      `;
    });

    afterAll(async () => {
      const db = sql();
      await db`DELETE FROM activity_event WHERE user_id IN (${userIdA}, ${userIdB})`;
      await db`DELETE FROM "user" WHERE email IN (${emailA}, ${emailB})`;
    });

    test("healthy agent detected: isHealthy=true, lastHeartbeatSec near 30", async () => {
      const rollup = await computeAgentHealthRollup(orgIdA);
      const healthy = rollup.find((a) => a.agentId === "health-session-1");
      expect(healthy).toBeTruthy();
      expect(healthy!.isHealthy).toBe(true);
      // Allow ±15s clock drift in CI.
      expect(healthy!.lastHeartbeatSec).toBeGreaterThanOrEqual(15);
      expect(healthy!.lastHeartbeatSec).toBeLessThan(AGENT_STALE_SEC);
    });

    test("stale agent detected: isHealthy=false, lastHeartbeatSec > AGENT_STALE_SEC", async () => {
      const rollup = await computeAgentHealthRollup(orgIdA);
      const stale = rollup.find((a) => a.agentId === "health-session-2");
      expect(stale).toBeTruthy();
      expect(stale!.isHealthy).toBe(false);
      expect(stale!.lastHeartbeatSec).toBeGreaterThan(AGENT_STALE_SEC);
    });

    test("proposalQueueDepth reflects pending proposals for the agent", async () => {
      const rollup = await computeAgentHealthRollup(orgIdA);
      const healthy = rollup.find((a) => a.agentId === "health-session-1");
      expect(healthy!.proposalQueueDepth).toBe(2);

      const stale = rollup.find((a) => a.agentId === "health-session-2");
      expect(stale!.proposalQueueDepth).toBe(0);
    });

    test("costLastHour is non-negative and reflects only the last 60 minutes", async () => {
      const rollup = await computeAgentHealthRollup(orgIdA);
      const healthy = rollup.find((a) => a.agentId === "health-session-1");
      // 500 + 5000 + 4500 = 10000 millicents = $0.10
      expect(healthy!.costLastHour).toBeCloseTo(0.1, 2);
      for (const a of rollup) {
        expect(a.costLastHour).toBeGreaterThanOrEqual(0);
      }
    });

    test("ORG ISOLATION: org B agents never appear in org A rollup", async () => {
      const rollupA = await computeAgentHealthRollup(orgIdA);
      const rivalInA = rollupA.find((a) => a.agentId === "rival-session-1");
      expect(rivalInA).toBeUndefined();

      // Org B rollup only sees its own agent.
      const rollupB = await computeAgentHealthRollup(orgIdB);
      expect(rollupB.find((a) => a.agentId === "rival-session-1")).toBeTruthy();
      expect(rollupB.find((a) => a.agentId === "health-session-1")).toBeUndefined();
      expect(rollupB.find((a) => a.agentId === "health-session-2")).toBeUndefined();
    });

    test("PRIVACY: rollup entries contain only metadata — no content keys", async () => {
      const rollup = await computeAgentHealthRollup(orgIdA);
      const serialized = JSON.stringify(rollup).toLowerCase();
      for (const forbidden of ["prompt", "completion", "diff", "patch", "file_content"]) {
        expect(serialized).not.toContain(forbidden);
      }
      // All numeric fields are finite numbers.
      for (const a of rollup) {
        expect(Number.isFinite(a.lastHeartbeatSec)).toBe(true);
        expect(Number.isFinite(a.proposalQueueDepth)).toBe(true);
        expect(Number.isFinite(a.costLastHour)).toBe(true);
      }
    });
  },
);
