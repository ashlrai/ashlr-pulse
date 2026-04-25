import { describe, expect, test } from "bun:test";
import { validateFields, FORBIDDEN_FIELDS } from "../src/lib/peer-share-guard";

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
