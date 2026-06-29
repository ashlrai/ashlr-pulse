/**
 * fleet-audit-sanitize.test.ts — privacy-floor sanitiser + command allow-list.
 *
 * Pure (no DB). Covers the foundation modules that back the fleet control
 * plane's egress safety:
 *
 *   1. sanitizeDetail() — strips forbidden content keys (recursively, case-
 *      insensitively), truncates over-long strings, and rejects non-objects.
 *      This is the LAST line of defence before a stored detail bag reaches a
 *      client, so the recursive/array cases matter: a forbidden key nested
 *      inside a sub-object must still be stripped.
 *
 *   2. FLEET_COMMAND_KINDS / assertCommandKind() — the closed allow-list that
 *      every control surface narrows arbitrary strings against.
 */

import { describe, expect, test } from "bun:test";
import {
  sanitizeDetail,
  MAX_DETAIL_STRING_LEN,
  FORBIDDEN_META_KEYS,
} from "../src/lib/fleet-audit";
import { FLEET_COMMAND_KINDS } from "../src/lib/graph-types";
import { assertCommandKind } from "../src/lib/fleet-commands-db";

describe("sanitizeDetail: flat stripping", () => {
  test("strips forbidden content keys, keeps safe metadata", () => {
    const clean = sanitizeDetail({
      engine: "anthropic/claude-sonnet-4-6",
      costUsd: 4.5,
      diff: "@@ -1 +1 @@",
      prompt: "you are a helpful assistant",
      stdout: "...",
    });
    expect(clean.engine).toBe("anthropic/claude-sonnet-4-6");
    expect(clean.costUsd).toBe(4.5);
    expect(Object.prototype.hasOwnProperty.call(clean, "diff")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(clean, "prompt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(clean, "stdout")).toBe(false);
  });

  test("forbidden-key match is case-insensitive", () => {
    const clean = sanitizeDetail({ Diff: "x", FILE_CONTENT: "y", Code: "z", ok: 1 });
    expect(clean.ok).toBe(1);
    expect(Object.keys(clean)).toEqual(["ok"]);
  });
});

describe("sanitizeDetail: recursion + arrays", () => {
  test("strips forbidden keys nested inside sub-objects", () => {
    const clean = sanitizeDetail({
      meta: { owner: "alice", diff: "@@ leak @@", nested: { code: "rm -rf /", count: 3 } },
    });
    const meta = clean.meta as Record<string, unknown>;
    expect(meta.owner).toBe("alice");
    expect(Object.prototype.hasOwnProperty.call(meta, "diff")).toBe(false);
    const nested = meta.nested as Record<string, unknown>;
    expect(nested.count).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(nested, "code")).toBe(false);
  });

  test("sanitises objects inside arrays element-wise", () => {
    // NB: "items" is a safe key; "files"/"body"/"prompt" are themselves
    // forbidden, so we nest the forbidden keys *inside* array elements.
    const clean = sanitizeDetail({
      items: [
        { name: "a.ts", body: "secret source" },
        { name: "b.ts", prompt: "leak" },
      ],
    });
    const items = clean.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]!.name).toBe("a.ts");
    expect(Object.prototype.hasOwnProperty.call(items[0]!, "body")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(items[1]!, "prompt")).toBe(false);
  });

  test("truncates over-long string values everywhere (top-level + nested)", () => {
    const huge = "x".repeat(MAX_DETAIL_STRING_LEN + 1000);
    const clean = sanitizeDetail({ note: huge, deep: { also: huge } });
    expect((clean.note as string).length).toBe(MAX_DETAIL_STRING_LEN);
    const deep = clean.deep as Record<string, unknown>;
    expect((deep.also as string).length).toBe(MAX_DETAIL_STRING_LEN);
  });
});

describe("sanitizeDetail: malformed input", () => {
  test("non-object input returns {}", () => {
    expect(sanitizeDetail(null)).toEqual({});
    expect(sanitizeDetail(undefined)).toEqual({});
    expect(sanitizeDetail("string")).toEqual({});
    expect(sanitizeDetail(42)).toEqual({});
    expect(sanitizeDetail([])).toEqual({});
    expect(sanitizeDetail([{ diff: "x" }])).toEqual({});
  });

  test("re-exported FORBIDDEN_META_KEYS is the single canonical set", () => {
    // The sanitiser must reuse the peer-share-guard set — never fork a copy.
    for (const k of ["diff", "code", "prompt", "stdout", "raw_otel_span"]) {
      expect(FORBIDDEN_META_KEYS.has(k)).toBe(true);
    }
  });
});

describe("FLEET_COMMAND_KINDS allow-list", () => {
  test("kinds are unique and non-empty", () => {
    expect(FLEET_COMMAND_KINDS.length).toBeGreaterThan(0);
    expect(new Set(FLEET_COMMAND_KINDS).size).toBe(FLEET_COMMAND_KINDS.length);
  });

  test("includes the proposal-inbox decision kinds", () => {
    expect(FLEET_COMMAND_KINDS).toContain("approve_proposal");
    expect(FLEET_COMMAND_KINDS).toContain("reject_proposal");
  });

  test("assertCommandKind narrows known kinds and rejects unknown ones", () => {
    for (const k of FLEET_COMMAND_KINDS) {
      expect(assertCommandKind(k)).toBe(k);
    }
    expect(() => assertCommandKind("definitely_not_a_kind")).toThrow();
    expect(() => assertCommandKind("")).toThrow();
  });
});
