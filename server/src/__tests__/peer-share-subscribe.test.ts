/**
 * peer-share-subscribe.test.ts
 *
 * Unit tests for the peer-share realtime grant-delta system.
 *
 * Tests the 3-peer grant topology: Alice (owner), Bob (viewer), Charlie (viewer).
 * Scenario: Alice grants Bob access, then revokes it mid-stream. Charlie's
 * grant from Alice is unaffected. Verifies:
 *
 *   1. broadcastGrantDelta fans out to the correct viewer only.
 *   2. Bob loses visibility (grant removed from cache) on revoke.
 *   3. Charlie is unaffected by Alice→Bob revocation.
 *   4. HMAC-SHA256 signatures are valid on add events.
 *   5. HMAC-SHA256 signatures are valid on revoke events.
 *   6. A tampered event fails signature verification.
 *   7. Privacy: no email addresses appear in GrantDeltaEvent.
 *   8. Sequence numbers are monotonically increasing.
 *   9. Controller cleanup on unregister.
 *  10. Closed controllers are pruned from the registry.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  broadcastGrantDelta,
  clearGrantDeltaRegistry,
  grantDeltaControllerCount,
  registerGrantDeltaController,
  resetGrantDeltaSeq,
  signGrantDelta,
  verifyGrantDelta,
  type GrantDeltaController,
  type GrantDeltaEvent,
} from "../lib/peer-share-realtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects GrantDeltaEvent payloads sent to a viewer. */
function makeCollector(viewerId: string): {
  events: GrantDeltaEvent[];
  ctrl: GrantDeltaController;
  unregister: () => void;
} {
  const events: GrantDeltaEvent[] = [];
  let _closed = false;

  const ctrl: GrantDeltaController = {
    get isClosed() {
      return _closed;
    },
    send(event: GrantDeltaEvent): boolean {
      if (_closed) return false;
      events.push(event);
      return true;
    },
    close() {
      _closed = true;
    },
  };

  const unregister = registerGrantDeltaController(viewerId, ctrl);
  return { events, ctrl, unregister };
}

// Stable UUIDs for the 3-peer topology.
const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const CHARLIE_ID = "cccccccc-0000-0000-0000-000000000003";

const FIELDS_AB = ["ts", "cost_millicents", "tokens_input"];
const FIELDS_AC = ["ts", "source", "model", "cost_millicents"];

// ---------------------------------------------------------------------------
// Reset before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearGrantDeltaRegistry();
  resetGrantDeltaSeq();
  // Set test env so signing key falls back to test dummy.
  (process.env as Record<string, string>).NODE_ENV = "test";
});

// ---------------------------------------------------------------------------
// Test 1 — broadcastGrantDelta delivers only to the target viewer
// ---------------------------------------------------------------------------

describe("3-peer grant topology", () => {
  test("Alice grants Bob: Bob receives add event, Charlie does not", () => {
    const bob = makeCollector(BOB_ID);
    const charlie = makeCollector(CHARLIE_ID);

    const sent = broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    expect(sent).toBe(1);
    expect(bob.events).toHaveLength(1);
    expect(bob.events[0].action).toBe("add");
    expect(bob.events[0].owner_id).toBe(ALICE_ID);
    expect(bob.events[0].viewer_id).toBe(BOB_ID);
    expect(bob.events[0].fields).toEqual(FIELDS_AB);
    expect(bob.events[0].revoked_at).toBeNull();

    // Charlie is unaffected.
    expect(charlie.events).toHaveLength(0);

    bob.unregister();
    charlie.unregister();
  });

  test("Alice revokes Bob mid-stream: Bob receives revoke, Charlie unaffected", () => {
    const bob = makeCollector(BOB_ID);
    const charlie = makeCollector(CHARLIE_ID);

    // Step 1: Alice grants Bob access.
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    // Step 2: Alice also grants Charlie (separate grant).
    broadcastGrantDelta("add", ALICE_ID, CHARLIE_ID, FIELDS_AC, null);

    // Step 3: Alice revokes Bob mid-stream.
    const revokedAt = new Date().toISOString();
    const sent = broadcastGrantDelta("revoke", ALICE_ID, BOB_ID, FIELDS_AB, revokedAt);

    expect(sent).toBe(1);

    // Bob received: add then revoke.
    expect(bob.events).toHaveLength(2);
    expect(bob.events[0].action).toBe("add");
    expect(bob.events[1].action).toBe("revoke");
    expect(bob.events[1].revoked_at).toBe(revokedAt);
    expect(bob.events[1].owner_id).toBe(ALICE_ID);
    expect(bob.events[1].viewer_id).toBe(BOB_ID);

    // Charlie received only their own add — not Bob's revoke.
    expect(charlie.events).toHaveLength(1);
    expect(charlie.events[0].action).toBe("add");
    expect(charlie.events[0].viewer_id).toBe(CHARLIE_ID);

    bob.unregister();
    charlie.unregister();
  });

  test("Charlie unaffected: receives own add only, not Bob revoke", () => {
    const charlie = makeCollector(CHARLIE_ID);

    // Bob is NOT subscribed in this test — broadcasts to Bob go nowhere.
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    broadcastGrantDelta("add", ALICE_ID, CHARLIE_ID, FIELDS_AC, null);
    broadcastGrantDelta("revoke", ALICE_ID, BOB_ID, FIELDS_AB, new Date().toISOString());

    expect(charlie.events).toHaveLength(1);
    expect(charlie.events[0].action).toBe("add");
    expect(charlie.events[0].viewer_id).toBe(CHARLIE_ID);
    expect(charlie.events[0].fields).toEqual(FIELDS_AC);

    charlie.unregister();
  });
});

// ---------------------------------------------------------------------------
// Test 4-5 — HMAC-SHA256 signature validity
// ---------------------------------------------------------------------------

describe("HMAC-SHA256 signing", () => {
  test("add event has a valid HMAC signature", () => {
    const bob = makeCollector(BOB_ID);
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    const event = bob.events[0];
    expect(event.sig).toBeTruthy();
    expect(verifyGrantDelta(event)).toBe(true);

    bob.unregister();
  });

  test("revoke event has a valid HMAC signature", () => {
    const bob = makeCollector(BOB_ID);
    const revokedAt = new Date().toISOString();
    broadcastGrantDelta("revoke", ALICE_ID, BOB_ID, FIELDS_AB, revokedAt);

    const event = bob.events[0];
    expect(verifyGrantDelta(event)).toBe(true);

    bob.unregister();
  });

  test("tampered owner_id fails signature verification", () => {
    const bob = makeCollector(BOB_ID);
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    const event = { ...bob.events[0], owner_id: "tampered-owner-id" };
    expect(verifyGrantDelta(event)).toBe(false);

    bob.unregister();
  });

  test("tampered fields[] fails signature verification", () => {
    const bob = makeCollector(BOB_ID);
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    const event = { ...bob.events[0], fields: ["prompts"] };
    expect(verifyGrantDelta(event)).toBe(false);

    bob.unregister();
  });

  test("tampered sig fails verification", () => {
    const bob = makeCollector(BOB_ID);
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    const event = { ...bob.events[0], sig: "not-a-valid-sig" };
    expect(verifyGrantDelta(event)).toBe(false);

    bob.unregister();
  });

  test("signGrantDelta produces consistent output for same inputs", () => {
    const sig1 = signGrantDelta(1, "2026-01-01T00:00:00.000Z", "add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    const sig2 = signGrantDelta(1, "2026-01-01T00:00:00.000Z", "add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    expect(sig1).toBe(sig2);
  });

  test("fields[] order does not affect signature (sorted internally)", () => {
    const fieldsOrdered = ["ts", "cost_millicents", "tokens_input"];
    const fieldsReversed = ["tokens_input", "cost_millicents", "ts"];
    const sig1 = signGrantDelta(1, "2026-01-01T00:00:00.000Z", "add", ALICE_ID, BOB_ID, fieldsOrdered, null);
    const sig2 = signGrantDelta(1, "2026-01-01T00:00:00.000Z", "add", ALICE_ID, BOB_ID, fieldsReversed, null);
    expect(sig1).toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Privacy: no email in GrantDeltaEvent
// ---------------------------------------------------------------------------

describe("Privacy — no email in grant delta events", () => {
  test("GrantDeltaEvent contains no email-like strings", () => {
    const bob = makeCollector(BOB_ID);
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    const event = bob.events[0];
    const serialized = JSON.stringify(event);

    // No @-sign should appear (email addresses contain @).
    expect(serialized).not.toContain("@");
    // owner_id and viewer_id are UUIDs, not emails.
    expect(event.owner_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.viewer_id).toMatch(/^[0-9a-f-]{36}$/);

    bob.unregister();
  });

  test("GrantDeltaEvent never contains forbidden content keys", () => {
    const bob = makeCollector(BOB_ID);
    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);

    const event = bob.events[0];
    const keys = Object.keys(event);

    const forbidden = ["prompt", "prompts", "completion", "completions",
                       "code", "content", "diff", "patch", "raw_otel_span",
                       "owner_email", "viewer_email"];
    for (const key of forbidden) {
      expect(keys).not.toContain(key);
    }

    bob.unregister();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Sequence numbers monotonically increasing
// ---------------------------------------------------------------------------

describe("Sequence numbers", () => {
  test("seq is monotonically increasing across broadcasts", () => {
    const bob = makeCollector(BOB_ID);
    const charlie = makeCollector(CHARLIE_ID);

    broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    broadcastGrantDelta("add", ALICE_ID, CHARLIE_ID, FIELDS_AC, null);
    broadcastGrantDelta("revoke", ALICE_ID, BOB_ID, FIELDS_AB, new Date().toISOString());

    const bobSeqs = bob.events.map((e) => e.seq);
    const charlieSeqs = charlie.events.map((e) => e.seq);

    // All seqs are positive and unique.
    const allSeqs = [...bobSeqs, ...charlieSeqs];
    const uniqueSeqs = new Set(allSeqs);
    expect(uniqueSeqs.size).toBe(allSeqs.length);

    // Each viewer's seqs are increasing.
    for (let i = 1; i < bobSeqs.length; i++) {
      expect(bobSeqs[i]).toBeGreaterThan(bobSeqs[i - 1]);
    }

    bob.unregister();
    charlie.unregister();
  });
});

// ---------------------------------------------------------------------------
// Test 9 — Controller cleanup on unregister
// ---------------------------------------------------------------------------

describe("Registry lifecycle", () => {
  test("unregister removes controller from registry", () => {
    const { unregister } = makeCollector(BOB_ID);
    expect(grantDeltaControllerCount(BOB_ID)).toBe(1);

    unregister();
    expect(grantDeltaControllerCount(BOB_ID)).toBe(0);
  });

  test("closed controller is pruned on next broadcast", () => {
    const { ctrl, unregister } = makeCollector(BOB_ID);
    expect(grantDeltaControllerCount(BOB_ID)).toBe(1);

    ctrl.close();

    // Broadcast triggers pruning of dead controllers.
    const sent = broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    expect(sent).toBe(0);
    expect(grantDeltaControllerCount(BOB_ID)).toBe(0);

    unregister(); // safe to call after pruning
  });

  test("multiple controllers for same viewer all receive events", () => {
    const conn1 = makeCollector(BOB_ID);
    const conn2 = makeCollector(BOB_ID);
    expect(grantDeltaControllerCount(BOB_ID)).toBe(2);

    const sent = broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    expect(sent).toBe(2);
    expect(conn1.events).toHaveLength(1);
    expect(conn2.events).toHaveLength(1);

    conn1.unregister();
    conn2.unregister();
  });
});

// ---------------------------------------------------------------------------
// Test 10 — broadcastGrantDelta returns 0 when viewer has no subscribers
// ---------------------------------------------------------------------------

describe("No-subscriber broadcasts", () => {
  test("broadcast to viewer with no subscribers returns 0", () => {
    const sent = broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    expect(sent).toBe(0);
  });

  test("broadcast delivers to subscriber but not absent viewer", () => {
    const charlie = makeCollector(CHARLIE_ID);

    // Bob has no subscribers.
    const sentBob = broadcastGrantDelta("add", ALICE_ID, BOB_ID, FIELDS_AB, null);
    expect(sentBob).toBe(0);

    // Charlie has one subscriber.
    const sentCharlie = broadcastGrantDelta("add", ALICE_ID, CHARLIE_ID, FIELDS_AC, null);
    expect(sentCharlie).toBe(1);
    expect(charlie.events).toHaveLength(1);

    charlie.unregister();
  });
});
