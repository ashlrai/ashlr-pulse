import { describe, expect, test } from "bun:test";
import { bucketFor, fmtAgo } from "../src/lib/heartbeat";

describe("bucketFor", () => {
  test("null → silent (never seen)", () => {
    expect(bucketFor(null)).toBe("silent");
  });
  test("under 5min → alive", () => {
    expect(bucketFor(0)).toBe("alive");
    expect(bucketFor(60)).toBe("alive");
    expect(bucketFor(299)).toBe("alive");
  });
  test("5-30min → stale", () => {
    expect(bucketFor(300)).toBe("stale");
    expect(bucketFor(900)).toBe("stale");
    expect(bucketFor(1799)).toBe("stale");
  });
  test("over 30min → silent", () => {
    expect(bucketFor(1800)).toBe("silent");
    expect(bucketFor(3600)).toBe("silent");
    expect(bucketFor(86400)).toBe("silent");
  });
});

describe("fmtAgo", () => {
  test.each([
    [null, "never"],
    [0, "0s"],
    [30, "30s"],
    [60, "1m"],
    [299, "4m"],
    [3599, "59m"],
    [3600, "1h"],
    [86399, "23h"],
    [86400, "1d"],
    [3 * 86400, "3d"],
  ])("%s seconds → %s", (s, expected) => {
    expect(fmtAgo(s as number | null)).toBe(expected);
  });
});
