/**
 * rate-limit.test.ts — token bucket behaviour.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { checkBucket, clearBuckets } from "../src/lib/rate-limit";

beforeEach(() => {
  clearBuckets();
});

describe("checkBucket", () => {
  test("allows requests up to capacity", () => {
    // Capacity 3, refill 1/s.
    for (let i = 0; i < 3; i++) {
      const r = checkBucket("test-key", 3, 1);
      expect(r.ok).toBe(true);
    }
  });

  test("denies when bucket is exhausted", () => {
    // Drain the bucket.
    for (let i = 0; i < 5; i++) {
      checkBucket("test-key-2", 5, 1);
    }
    const denied = checkBucket("test-key-2", 5, 1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterSec).toBeGreaterThan(0);
    }
  });

  test("different keys have independent buckets", () => {
    // Drain key-a completely (cap 2).
    checkBucket("key-a", 2, 1);
    checkBucket("key-a", 2, 1);
    const denied = checkBucket("key-a", 2, 1);
    expect(denied.ok).toBe(false);

    // key-b should still be full.
    const allowed = checkBucket("key-b", 2, 1);
    expect(allowed.ok).toBe(true);
  });

  test("returns remaining tokens on allow", () => {
    const r = checkBucket("rem-key", 10, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.remaining).toBe(9);
    }
  });

  test("429 fires after hammering beyond capacity", () => {
    let deniedCount = 0;
    for (let i = 0; i < 70; i++) {
      const r = checkBucket("hammer-key", 60, 1);
      if (!r.ok) deniedCount++;
    }
    // At least some requests should be denied.
    expect(deniedCount).toBeGreaterThan(0);
  });

  test("clearBuckets resets state between tests", () => {
    checkBucket("reset-key", 1, 1); // drains the 1-token bucket
    clearBuckets();
    const r = checkBucket("reset-key", 1, 1);
    expect(r.ok).toBe(true); // bucket is fresh again
  });
});
