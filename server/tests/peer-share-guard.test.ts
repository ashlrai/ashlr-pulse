import { describe, expect, test } from "bun:test";
import {
  validateFields,
  FORBIDDEN_FIELDS,
  assertMetadataOnly,
  MetadataFloorError,
  FORBIDDEN_META_KEYS,
} from "../src/lib/peer-share-guard";

describe("validateFields", () => {
  test("accepts a valid whitelist", () => {
    const r = validateFields(["ts", "source", "model", "tokens_input"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.sort()).toEqual(["model", "source", "tokens_input", "ts"]);
    }
  });

  test("dedupes repeated fields", () => {
    const r = validateFields(["ts", "ts", "source"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields).toHaveLength(2);
  });

  test.each([...FORBIDDEN_FIELDS])("rejects forbidden field %s", (f) => {
    const r = validateFields(["ts", f]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toContain(f);
    }
  });

  test("rejects unknown field that isn't on the shareable list", () => {
    const r = validateFields(["ts", "internal_audit_trail"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  test("rejects empty array", () => {
    const r = validateFields([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test("rejects non-array input", () => {
    const r = validateFields("ts,source" as unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test("rejects non-string element", () => {
    const r = validateFields(["ts", 42] as unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// assertMetadataOnly — Map privacy floor for graph node/edge meta bags.
// Critical: this guard is the last line of defence before fleet-supplied
// meta reaches the DB. Every path that ingests fleet meta MUST run it.
// ---------------------------------------------------------------------------

describe("assertMetadataOnly — valid metadata passes through", () => {
  test("returns the input object unchanged on success (for chaining)", () => {
    const meta = { repo: "acme/api", health: 85, engine: "claude" };
    expect(assertMetadataOnly(meta)).toBe(meta);
  });

  test("null input passes (no-op)", () => {
    expect(() => assertMetadataOnly(null)).not.toThrow();
  });

  test("primitive input passes (non-object, no-op)", () => {
    expect(() => assertMetadataOnly(42 as unknown)).not.toThrow();
    expect(() => assertMetadataOnly("hello" as unknown)).not.toThrow();
  });

  test("safe nested object passes", () => {
    const meta = { stats: { proposals: 3, merged: 2 }, tags: ["fleet", "v4"] };
    expect(() => assertMetadataOnly(meta)).not.toThrow();
  });

  test("array of safe strings passes", () => {
    expect(() => assertMetadataOnly(["acme/api", "acme/web"] as unknown)).not.toThrow();
  });

  test("string value at max allowed length passes", () => {
    const meta = { description: "x".repeat(2048) };
    expect(() => assertMetadataOnly(meta)).not.toThrow();
  });
});

describe("assertMetadataOnly — forbidden keys throw MetadataFloorError", () => {
  test.each([...FORBIDDEN_META_KEYS])(
    "rejects top-level forbidden key %s",
    (key) => {
      const meta = { [key]: "some value" };
      expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
    },
  );

  test("rejects forbidden key in nested object", () => {
    const meta = { outer: { prompt: "do something bad" } };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });

  test("rejects forbidden key case-insensitively (mixed-case DIFF)", () => {
    // assertMetadataOnly lowercases keys before checking — "DIFF" must be caught.
    const meta = { DIFF: "--- a/file\n+++ b/file" };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });

  test("rejects forbidden key case-insensitively (Title-case Prompt)", () => {
    const meta = { Prompt: "tell me everything" };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });

  test("error message names the offending path", () => {
    const meta = { edge: { diff: "bad patch content" } };
    let caught: MetadataFloorError | null = null;
    try {
      assertMetadataOnly(meta, "properties");
    } catch (e) {
      caught = e as MetadataFloorError;
    }
    expect(caught).toBeInstanceOf(MetadataFloorError);
    // Path should reference where in the object the violation was found.
    expect(caught!.message).toContain("properties");
  });

  test("rejects forbidden key inside array element", () => {
    // Arrays of objects are valid in meta; but their keys must still be clean.
    const meta = { nodes: [{ label: "safe" }, { prompt: "not safe" }] };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });
});

describe("assertMetadataOnly — oversized string values throw MetadataFloorError", () => {
  test("string value one char over limit (2049 chars) is rejected", () => {
    const meta = { description: "x".repeat(2049) };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });

  test("error message mentions the offending path and char count", () => {
    const meta = { summary: "y".repeat(3000) };
    let caught: MetadataFloorError | null = null;
    try {
      assertMetadataOnly(meta);
    } catch (e) {
      caught = e as MetadataFloorError;
    }
    expect(caught).toBeInstanceOf(MetadataFloorError);
    expect(caught!.message).toContain("3000");
    expect(caught!.message).toContain("summary");
  });

  test("oversized string in nested object is rejected", () => {
    const meta = { outer: { inner: "z".repeat(2049) } };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });

  test("oversized string inside array element is rejected", () => {
    const meta = { tags: ["short", "x".repeat(2049)] };
    expect(() => assertMetadataOnly(meta)).toThrow(MetadataFloorError);
  });
});
