import { describe, expect, test } from "bun:test";
import { validateQuery } from "../src/lib/ask-pulse";

describe("validateQuery", () => {
  test("accepts a well-formed query", () => {
    const v = validateQuery({
      metric: "tokens", group_by: "day", window_days: 7,
      sort: "bucket_asc", limit: 30,
    });
    expect(v).toEqual({
      metric: "tokens", group_by: "day", window_days: 7,
      filter: undefined, sort: "bucket_asc", limit: 30,
    });
  });

  test("rejects unknown metric", () => {
    expect(validateQuery({ metric: "evil" as never, group_by: "day", window_days: 7 })).toBeNull();
  });

  test("rejects unknown group_by", () => {
    expect(validateQuery({ metric: "events", group_by: "evil" as never, window_days: 7 })).toBeNull();
  });

  test("clamps window_days into [1, 90]", () => {
    expect(validateQuery({ metric: "events", group_by: "day", window_days: 9999 })?.window_days).toBe(90);
    expect(validateQuery({ metric: "events", group_by: "day", window_days: -5 })?.window_days).toBe(1);
    expect(validateQuery({ metric: "events", group_by: "day", window_days: NaN })?.window_days).toBe(1);
  });

  test("clamps limit into [1, 50]", () => {
    expect(validateQuery({ metric: "events", group_by: "day", window_days: 7, limit: 999 })?.limit).toBe(50);
    expect(validateQuery({ metric: "events", group_by: "day", window_days: 7, limit: 0 })?.limit).toBe(1);
  });

  test("defaults sort to value_desc and limit to 10", () => {
    const v = validateQuery({ metric: "events", group_by: "source", window_days: 7 });
    expect(v?.sort).toBe("value_desc");
    expect(v?.limit).toBe(10);
  });

  test("only accepts known sort values", () => {
    const v = validateQuery({ metric: "events", group_by: "day", window_days: 7, sort: "evil" as never });
    expect(v?.sort).toBe("value_desc");
  });

  test("filter is optional and only carries known fields", () => {
    const v = validateQuery({
      metric: "events", group_by: "day", window_days: 7,
      filter: { source: "claude_code", repo: "ashlr/pulse", model: "claude-opus-4-7" },
    });
    expect(v?.filter).toEqual({ source: "claude_code", repo: "ashlr/pulse", model: "claude-opus-4-7" });
  });
});
