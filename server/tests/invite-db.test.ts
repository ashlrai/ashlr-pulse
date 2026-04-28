import { describe, expect, test } from "bun:test";
import { generateToken } from "../src/lib/invite-db";

describe("invite generateToken", () => {
  test("default length is 16", () => {
    expect(generateToken().length).toBe(16);
  });

  test("respects custom length", () => {
    expect(generateToken(24).length).toBe(24);
  });

  test("alphabet excludes ambiguous chars (0,1,I,O)", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateToken(16)).toMatch(/^[2-9A-HJ-NP-Z]{16}$/);
    }
  });

  test("100 tokens are all unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateToken());
    expect(seen.size).toBe(100);
  });
});
