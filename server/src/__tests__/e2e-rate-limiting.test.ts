/**
 * e2e-rate-limiting.test.ts
 *
 * End-to-end integration test for the OTel ingest rate-limiting pipeline.
 *
 * Coverage:
 *   1. 65 concurrent checkBucket() calls against the same PAT key with a
 *      capacity of 60 — verifies exactly 60 succeed and 5 are denied (429).
 *   2. The in-process bucket resets after clearing (simulating hourly reset).
 *   3. Different PAT keys are independent (isolation between tenants).
 *   4. The retryAfterSec on a denied result is positive.
 *   5. After clearing (hourly reset) the same key is admitted again.
 *
 * These are pure in-memory unit tests (checkBucket uses an in-process bucket
 * map) so they run without a DB. They live here in __tests__/ alongside the
 * DB-gated e2e tests so CI can locate them in one sweep.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { checkBucket, clearBuckets } from "../lib/rate-limit";

// Reset the bucket map between each test for isolation.
beforeEach(() => {
  clearBuckets();
});

// ─────────────────────────────────────────────────────────────────────────────
// Core rate-limit invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("e2e rate limiting — 65 concurrent requests, capacity 60", () => {
  test("exactly 60 of 65 concurrent requests succeed, 5 are rate-limited (429)", () => {
    const CAPACITY = 60;
    const TOTAL = 65;
    const EXPECTED_DENIED = TOTAL - CAPACITY;
    const patKey = `pat-e2e-concurrent-${Date.now()}`;

    let allowed = 0;
    let denied = 0;
    const deniedResults: { retryAfterSec: number }[] = [];

    // Fire all 65 requests "concurrently" (synchronous — in-process bucket
    // is synchronous, so parallel JS microtasks aren't needed; any ordering
    // within a single JS tick is deterministic under the token-bucket model).
    for (let i = 0; i < TOTAL; i++) {
      const result = checkBucket(patKey, CAPACITY, 1);
      if (result.ok) {
        allowed++;
      } else {
        denied++;
        deniedResults.push({ retryAfterSec: result.retryAfterSec });
      }
    }

    expect(allowed).toBe(CAPACITY);
    expect(denied).toBe(EXPECTED_DENIED);

    // Every denied result must carry a positive retryAfterSec
    for (const r of deniedResults) {
      expect(r.retryAfterSec).toBeGreaterThan(0);
    }
  });

  test("after bucket state resets (clearBuckets), the same PAT is admitted again", () => {
    const CAPACITY = 60;
    const patKey = `pat-e2e-reset-${Date.now()}`;

    // Drain the bucket
    for (let i = 0; i < CAPACITY; i++) {
      checkBucket(patKey, CAPACITY, 1);
    }
    // One more must be denied
    const denied = checkBucket(patKey, CAPACITY, 1);
    expect(denied.ok).toBe(false);

    // Simulate hourly reset
    clearBuckets();

    // Now the bucket is fresh
    const fresh = checkBucket(patKey, CAPACITY, 1);
    expect(fresh.ok).toBe(true);
  });

  test("different PAT keys have independent buckets (no cross-tenant leak)", () => {
    const CAPACITY = 5;
    const keyA = `pat-e2e-keyA-${Date.now()}`;
    const keyB = `pat-e2e-keyB-${Date.now()}`;

    // Drain key A
    for (let i = 0; i < CAPACITY; i++) {
      checkBucket(keyA, CAPACITY, 1);
    }
    // Key A is exhausted
    const deniedA = checkBucket(keyA, CAPACITY, 1);
    expect(deniedA.ok).toBe(false);

    // Key B is still full
    const allowedB = checkBucket(keyB, CAPACITY, 1);
    expect(allowedB.ok).toBe(true);
    if (allowedB.ok) expect(allowedB.remaining).toBe(CAPACITY - 1);
  });

  test("retryAfterSec is positive on a denied request", () => {
    const CAPACITY = 3;
    const patKey = `pat-e2e-retry-${Date.now()}`;

    // Drain bucket
    for (let i = 0; i < CAPACITY; i++) checkBucket(patKey, CAPACITY, 1);

    const denied = checkBucket(patKey, CAPACITY, 1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  test("remaining decrements correctly as requests are admitted", () => {
    const CAPACITY = 10;
    const patKey = `pat-e2e-remaining-${Date.now()}`;

    for (let i = 0; i < CAPACITY; i++) {
      const r = checkBucket(patKey, CAPACITY, 1);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.remaining).toBe(CAPACITY - 1 - i);
    }

    // 11th request is denied
    const r11 = checkBucket(patKey, CAPACITY, 1);
    expect(r11.ok).toBe(false);
  });

  test("hammer test: 200 requests against capacity 60 yields ≥ 140 denied", () => {
    const CAPACITY = 60;
    const TOTAL = 200;
    const patKey = `pat-e2e-hammer-${Date.now()}`;

    let denied = 0;
    for (let i = 0; i < TOTAL; i++) {
      const r = checkBucket(patKey, CAPACITY, 1);
      if (!r.ok) denied++;
    }
    // At least TOTAL - CAPACITY requests should be denied
    expect(denied).toBeGreaterThanOrEqual(TOTAL - CAPACITY);
  });

  test("clearBuckets() simulates hourly reset — re-validates post-reset admission", () => {
    const CAPACITY = 60;
    const REFILL = 1; // 1 token/sec — same as production default
    const patKey = `pat-e2e-hourly-${Date.now()}`;

    // Fill to exhaustion
    for (let i = 0; i < CAPACITY; i++) checkBucket(patKey, CAPACITY, REFILL);
    const exhausted = checkBucket(patKey, CAPACITY, REFILL);
    expect(exhausted.ok).toBe(false);

    // Simulate the hourly bucket drop (cron that calls clearBuckets in prod)
    clearBuckets();

    // Bucket is restored — first request should be admitted
    const postReset = checkBucket(patKey, CAPACITY, REFILL);
    expect(postReset.ok).toBe(true);
    if (postReset.ok) {
      // Remaining = capacity - 1 after one consume
      expect(postReset.remaining).toBe(CAPACITY - 1);
    }
  });
});
