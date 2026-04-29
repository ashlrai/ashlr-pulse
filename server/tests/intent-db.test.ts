/**
 * Tests for weekStartUtc — the only time math in intent-db. The DB
 * helpers are integration-shaped (need Postgres) and covered by the
 * existing test pattern; weekStartUtc is pure and worth locking down
 * since timezone-adjacent code is the most common source of off-by-one
 * bugs.
 */

import { describe, test, expect } from "bun:test";
import { weekStartUtc } from "../src/lib/intent-db";

describe("weekStartUtc", () => {
  test("Monday returns the same date", () => {
    // 2026-04-27 is a Monday (UTC).
    expect(weekStartUtc(new Date("2026-04-27T00:00:00Z"))).toBe("2026-04-27");
    expect(weekStartUtc(new Date("2026-04-27T18:30:00Z"))).toBe("2026-04-27");
  });

  test("mid-week resolves back to the same Monday", () => {
    // 2026-04-29 is a Wednesday (UTC); Monday of that week is 2026-04-27.
    expect(weekStartUtc(new Date("2026-04-29T00:00:00Z"))).toBe("2026-04-27");
    expect(weekStartUtc(new Date("2026-05-01T23:59:59Z"))).toBe("2026-04-27");
  });

  test("Sunday rolls back six days, not forward one", () => {
    // 2026-05-03 is a Sunday (UTC). Monday of *this* week (the one that
    // started six days earlier) is 2026-04-27. Off-by-one trap — Sunday
    // should NOT resolve to the next Monday.
    expect(weekStartUtc(new Date("2026-05-03T00:00:00Z"))).toBe("2026-04-27");
    expect(weekStartUtc(new Date("2026-05-03T23:59:59Z"))).toBe("2026-04-27");
  });

  test("crossing a Monday advances the week", () => {
    expect(weekStartUtc(new Date("2026-05-04T00:00:00Z"))).toBe("2026-05-04"); // next Monday
  });

  test("crossing a month boundary still resolves correctly", () => {
    // 2026-05-01 is a Friday (UTC); Monday is 2026-04-27.
    expect(weekStartUtc(new Date("2026-05-01T12:00:00Z"))).toBe("2026-04-27");
  });
});
