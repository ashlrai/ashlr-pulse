/**
 * Tests for the pure helpers in project-db.ts. The DB-touching helpers
 * (listUnassignedRepos, aggregateByProject) are exercised by the smoke
 * test in QUICKSTART; here we lock down the prefix-clustering heuristic
 * so accidental edits can't ship "claude/aider/sgpt all bucketed under
 * 'cl' " level regressions.
 */

import { describe, expect, test } from "bun:test";
import { clusterByPrefix } from "../src/lib/project-db";

describe("clusterByPrefix", () => {
  test("groups repos sharing a prefix joined by '-'", () => {
    const c = clusterByPrefix(["client-foo", "client-bar", "client-baz"]);
    expect(c).toHaveLength(1);
    expect(c[0].prefix).toBe("client");
    expect(c[0].repos).toEqual(["client-bar", "client-baz", "client-foo"]);
  });

  test("groups repos sharing a prefix joined by '_'", () => {
    const c = clusterByPrefix(["saas_api", "saas_web"]);
    expect(c[0].prefix).toBe("saas");
    expect(c[0].repos).toHaveLength(2);
  });

  test("strips owner segment so cross-org repos still cluster", () => {
    const c = clusterByPrefix([
      "AshlrAI/client-foo",
      "evero/client-bar",
      "AshlrAI/client-baz",
    ]);
    expect(c[0].prefix).toBe("client");
    expect(c[0].repos).toHaveLength(3);
  });

  test("ignores singletons", () => {
    const c = clusterByPrefix(["one-off-thing", "client-foo", "client-bar"]);
    expect(c).toHaveLength(1);
    expect(c[0].prefix).toBe("client");
  });

  test("ignores repos with no separator", () => {
    expect(clusterByPrefix(["pulse", "cotidie"])).toEqual([]);
  });

  test("sorts clusters by size descending", () => {
    const c = clusterByPrefix([
      "saas-api", "saas-web",
      "client-a", "client-b", "client-c", "client-d",
    ]);
    expect(c[0].prefix).toBe("client");
    expect(c[0].repos).toHaveLength(4);
    expect(c[1].prefix).toBe("saas");
    expect(c[1].repos).toHaveLength(2);
  });

  test("case-insensitive prefix matching", () => {
    const c = clusterByPrefix(["Client-A", "client-B"]);
    expect(c[0].prefix).toBe("client");
    expect(c[0].repos).toHaveLength(2);
  });

  test("handles empty input", () => {
    expect(clusterByPrefix([])).toEqual([]);
  });
});
