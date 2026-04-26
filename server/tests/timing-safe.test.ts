import { describe, expect, test } from "bun:test";
import { safeEqual, clientIp } from "../src/lib/timing-safe";

describe("safeEqual", () => {
  test("equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
  });
  test("unequal strings of equal length", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "Abc")).toBe(false);
  });
  test("unequal lengths short-circuit safely", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
  test("utf8 bytes (not codepoints) — emoji compare correctly", () => {
    expect(safeEqual("🦀", "🦀")).toBe(true);
    expect(safeEqual("🦀", "🐙")).toBe(false);
  });
});

describe("clientIp", () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request("http://x.test/", { headers });
  }

  test("rightmost x-forwarded-for is canonical (Railway / most proxies)", () => {
    // Client supplied "1.2.3.4" but the platform appended the real IP.
    expect(clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 192.0.2.1" }))).toBe("192.0.2.1");
  });

  test("single-value x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  test("trims whitespace", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "  1.2.3.4  ,  198.51.100.7  " }))).toBe("198.51.100.7");
  });

  test("attacker prepends garbage — we still pick platform value", () => {
    expect(
      clientIp(reqWith({ "x-forwarded-for": "evil.com, 0.0.0.0, 192.0.2.1" })),
    ).toBe("192.0.2.1");
  });

  test("falls back to x-real-ip when no x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-real-ip": "203.0.113.99" }))).toBe("203.0.113.99");
  });

  test("falls back to 'unknown' when neither header is present", () => {
    expect(clientIp(reqWith({}))).toBe("unknown");
  });

  test("empty x-forwarded-for falls through to x-real-ip", () => {
    expect(
      clientIp(reqWith({ "x-forwarded-for": "", "x-real-ip": "192.0.2.50" })),
    ).toBe("192.0.2.50");
  });
});
