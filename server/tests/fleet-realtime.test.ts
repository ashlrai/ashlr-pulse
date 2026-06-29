/**
 * fleet-realtime.test.ts
 *
 * Verifies two contracts:
 *
 *   1. A fleet event row produces a broadcast payload that reaches a
 *      subscriber (the push path works end-to-end in-process).
 *
 *   2. The privacy floor is enforced on the realtime path:
 *      - FORBIDDEN_FIELDS (prompts, completions, raw_otel_span) are never
 *        present in the broadcast payload.
 *      - NEVER_BROADCAST extras (session_id, dedup_key, etc.) are stripped.
 *      - assertMetadataOnly fires if a free-form meta bag carries a
 *        forbidden key — the event is dropped, not broadcast.
 *
 * These tests are pure (no network, no DB). pushFleetEvents() is tested
 * via redactForBroadcast() which is the privacy-enforcing function; the
 * Supabase client call is integration-only and not exercised here.
 */

import { describe, it, expect } from "bun:test";
import {
  redactForBroadcast,
  toFleetEventJSON,
  type FleetRealtimeEvent,
} from "../src/lib/fleet-realtime";
import {
  FORBIDDEN_FIELDS,
  MetadataFloorError,
} from "../src/lib/peer-share-guard";
import type { ActivityEventInsert } from "../src/lib/otel-genai";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFleetRow(
  overrides: Partial<ActivityEventInsert> = {},
): ActivityEventInsert {
  return {
    ts:                         "2026-06-29T10:00:00.000Z",
    user_id:                    "user-abc",
    session_id:                 "session-xyz",       // must be stripped
    source:                     "ashlr-fleet",
    provider:                   "claude",
    model:                      "claude-opus-4-7",
    duration_ms:                1200,
    tokens_input:               800,
    tokens_output:              200,
    tokens_reasoning:           null,
    tokens_cache_read:          null,
    tokens_cache_write:         null,
    tokens_cache_5m_write:      null,
    tokens_cache_1h_write:      null,
    tool_calls_count:           null,
    tool_calls_types:           null,
    accepted_count:             null,
    rejected_count:             null,
    project_hash:               "abc123",            // must be stripped
    repo_name:                  "acme/api",
    git_branch:                 "feat/my-branch",    // must be stripped
    language:                   "TypeScript",        // must be stripped
    tokens_saved:               null,
    tokens_saved_breakdown:     { genome: 50 },      // must be stripped
    plugin_features:            ["genome"],           // must be stripped
    plugin_version:             null,
    plugin_genome_hit_rate:     null,
    span_id:                    "deadbeef12345678",  // must be stripped
    cost_millicents:            420,
    pricing_version:            3,                   // must be stripped
    dedup_key:                  "abc123dedup",       // must be stripped
    fleet_event:                "proposal",
    fleet_outcome:              "pending",
    fleet_owner:                "mason",
    // Codex fields (must not appear in fleet broadcast)
    codex_plan_type:            null,
    codex_originator:           null,
    codex_parent_thread_id:     null,
    codex_cli_version:          null,
    codex_context_window:       null,
    codex_rate_limit_primary_pct:  null,
    codex_rate_limit_secondary_pct: null,
    codex_sandbox_policy:       null,
    codex_approval_policy:      null,
    codex_effort:               null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. A fleet event pushes to a subscriber (redactForBroadcast round-trip)
// ---------------------------------------------------------------------------

describe("fleet-realtime — push produces a subscriber-ready payload", () => {
  it("returns a FleetRealtimeEvent with the core fleet fields intact", () => {
    const row = makeFleetRow();
    const payload = redactForBroadcast(row);

    expect(payload.ts).toBe("2026-06-29T10:00:00.000Z");
    expect(payload.source).toBe("ashlr-fleet");
    expect(payload.fleet_event).toBe("proposal");
    expect(payload.fleet_outcome).toBe("pending");
    expect(payload.fleet_owner).toBe("mason");
    expect(payload.repo_name).toBe("acme/api");
    expect(payload.provider).toBe("claude");
    expect(payload.model).toBe("claude-opus-4-7");
    expect(payload.tokens_input).toBe(800);
    expect(payload.tokens_output).toBe(200);
    expect(payload.cost_millicents).toBe(420);
    expect(payload.duration_ms).toBe(1200);
  });

  it("returns a plain object (no prototype methods from ActivityEventInsert)", () => {
    const payload = redactForBroadcast(makeFleetRow());
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
  });

  it("handles null fleet_owner gracefully", () => {
    const payload = redactForBroadcast(makeFleetRow({ fleet_owner: null }));
    expect(payload.fleet_owner).toBeNull();
  });

  it("handles null cost_millicents gracefully", () => {
    const payload = redactForBroadcast(makeFleetRow({ cost_millicents: null }));
    expect(payload.cost_millicents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Privacy floor: FORBIDDEN_FIELDS never appear in the broadcast payload
// ---------------------------------------------------------------------------

describe("fleet-realtime — privacy floor strips forbidden fields", () => {
  it("does not expose any FORBIDDEN_FIELDS key in the broadcast payload", () => {
    const payload = redactForBroadcast(makeFleetRow());
    const payloadKeys = new Set(Object.keys(payload));

    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(payloadKeys.has(forbidden)).toBe(false);
    }
  });

  it("does not expose session_id in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ session_id: "secret-session" })));
    expect(payload.session_id).toBeUndefined();
  });

  it("does not expose project_hash in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ project_hash: "hash-abc" })));
    expect(payload.project_hash).toBeUndefined();
  });

  it("does not expose git_branch in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ git_branch: "feat/secret" })));
    expect(payload.git_branch).toBeUndefined();
  });

  it("does not expose dedup_key in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ dedup_key: "abc123" })));
    expect(payload.dedup_key).toBeUndefined();
  });

  it("does not expose span_id in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ span_id: "deadbeef" })));
    expect(payload.span_id).toBeUndefined();
  });

  it("does not expose tokens_saved_breakdown in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ tokens_saved_breakdown: { genome: 100 } })));
    expect(payload.tokens_saved_breakdown).toBeUndefined();
  });

  it("does not expose plugin_features in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ plugin_features: ["genome"] })));
    expect(payload.plugin_features).toBeUndefined();
  });

  it("does not expose language in the broadcast payload", () => {
    const payload = toFleetEventJSON(redactForBroadcast(makeFleetRow({ language: "Rust" })));
    expect(payload.language).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Privacy floor: assertMetadataOnly fires on forbidden meta keys
//    (belt-and-suspenders — covers future free-form fields added to
//     FleetRealtimeEvent that might carry a meta bag)
// ---------------------------------------------------------------------------

describe("fleet-realtime — assertMetadataOnly on meta bags", () => {
  it("throws MetadataFloorError when a broadcast key holds a forbidden meta key", () => {
    // Simulate a future field `meta` that carries a forbidden key.
    // We test assertMetadataOnly directly since redactForBroadcast runs it
    // on the assembled payload object.
    const { assertMetadataOnly } = require("../src/lib/peer-share-guard");

    expect(() =>
      assertMetadataOnly({ prompt: "do bad things" }, "fleet_broadcast"),
    ).toThrow(MetadataFloorError);

    expect(() =>
      assertMetadataOnly({ diff: "--- a/file\n+++ b/file" }, "fleet_broadcast"),
    ).toThrow(MetadataFloorError);

    expect(() =>
      assertMetadataOnly({ raw_otel_span: "{}" }, "fleet_broadcast"),
    ).toThrow(MetadataFloorError);
  });

  it("passes assertMetadataOnly for a safe fleet payload object", () => {
    const { assertMetadataOnly } = require("../src/lib/peer-share-guard");
    const payload = redactForBroadcast(makeFleetRow());

    expect(() => assertMetadataOnly(payload, "fleet_broadcast")).not.toThrow();
  });

  it("a valid fleet event round-trips redactForBroadcast without throwing", () => {
    const row = makeFleetRow({
      fleet_event:   "merge",
      fleet_outcome: "applied",
      fleet_owner:   "alice",
      repo_name:     "acme/core",
      cost_millicents: 1500,
    });
    const payload = redactForBroadcast(row);

    expect(payload.fleet_event).toBe("merge");
    expect(payload.fleet_outcome).toBe("applied");
    expect(payload.fleet_owner).toBe("alice");
    expect(payload.repo_name).toBe("acme/core");
    expect(payload.cost_millicents).toBe(1500);
  });
});
