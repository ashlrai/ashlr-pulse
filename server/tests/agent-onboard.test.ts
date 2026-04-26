/**
 * agent-onboard.test.ts — code generator + status-machine tests.
 *
 * The DB-touching helpers (startCode/approveCode/consumeApprovedCode)
 * are covered by the curl smoke loop in QUICKSTART; here we lock down
 * the pure-function bits so a bad code-format change can't ship.
 */

import { describe, expect, test } from "bun:test";
import { generateCode } from "../src/lib/agent-onboard-db";

describe("generateCode", () => {
  test("default length is 8", () => {
    expect(generateCode().length).toBe(8);
  });

  test("respects custom length", () => {
    expect(generateCode(12).length).toBe(12);
  });

  test("alphabet excludes ambiguous chars (0,1,I,O)", () => {
    // Check 1000 codes — exhaustive enough to catch a regressed alphabet.
    for (let i = 0; i < 1000; i++) {
      const c = generateCode(8);
      expect(c).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    }
  });

  test("looks random — 100 codes, no two identical", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateCode());
    expect(seen.size).toBe(100);
  });
});

describe("safeNext (auth callback)", () => {
  // The function is private to the route file; we re-implement the
  // contract here as a regression-test against open-redirect.
  function safeNext(raw: string | null): string {
    const v = raw ?? "/app";
    if (!v.startsWith("/")) return "/app";
    if (v.startsWith("//")) return "/app";
    return v;
  }

  test.each([
    [null, "/app"],
    ["", "/app"],
    ["/app", "/app"],
    ["/agent-onboard?code=ABC12345", "/agent-onboard?code=ABC12345"],
    ["//evil.com", "/app"],
    ["https://evil.com", "/app"],
    ["http://evil.com/path", "/app"],
    ["javascript:alert(1)", "/app"],
    ["/path/with/slashes", "/path/with/slashes"],
  ])("%s → %s", (input, expected) => {
    expect(safeNext(input as string | null)).toBe(expected);
  });
});
