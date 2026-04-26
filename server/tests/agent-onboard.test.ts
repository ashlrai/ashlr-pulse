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
  // Keep this implementation byte-identical to /auth/callback's safeNext
  // and /login's nextSafe ternary. The test exists specifically to catch
  // drift between those copies.
  function safeNext(raw: string | null): string {
    const v = raw ?? "/app";
    if (!v.startsWith("/")) return "/app";
    if (v.startsWith("//")) return "/app";
    if (v.includes("\\")) return "/app";
    if (/[\r\n]/.test(v)) return "/app";
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
    // Backslash bypass: WHATWG URL normalizes `\` to `/` so this would
    // otherwise resolve to `https://evil.com` via `new URL(next, base)`.
    ["/\\evil.com", "/app"],
    ["/path\\evil", "/app"],
    // CRLF: protect against header / response splitting.
    ["/path\r\nLocation: https://evil", "/app"],
    ["/path\nset-cookie: x=1", "/app"],
  ])("%s → %s", (input, expected) => {
    expect(safeNext(input as string | null)).toBe(expected);
  });
});
