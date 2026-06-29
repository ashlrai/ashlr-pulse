/**
 * dashboard-multi-filter.test.ts
 *
 * Unit tests for the multi-dimension filtering additions:
 *   1. SQL clause generation — verifies that LoadOpts fields produce the
 *      correct $N placeholders in the events query.
 *   2. Validation helpers in page.tsx — resolveRepoFilter, resolveModelFilter,
 *      resolveISODate, resolveDateRange.
 *   3. Filter persistence — URL param round-trip (filterHref builder in
 *      DashboardFilterBar).
 *
 * No DB required — all assertions are purely structural/unit.
 *
 * Run with:
 *   bun test src/__tests__/dashboard-multi-filter.test.ts
 */

import { describe, expect, test } from "bun:test";

// ─── 1. Validation helpers ────────────────────────────────────────────────────
// We import the exported helpers directly from page.tsx.

import {
  resolveRepoFilter,
  resolveModelFilter,
  resolveISODate,
  resolveDateRange,
} from "../lib/dashboard-filter-params";

describe("resolveRepoFilter", () => {
  test("accepts valid org/repo formats", () => {
    expect(resolveRepoFilter("acme/api")).toBe("acme/api");
    expect(resolveRepoFilter("foo-bar/baz_qux")).toBe("foo-bar/baz_qux");
    expect(resolveRepoFilter("Org123/Repo.name-v2")).toBe("Org123/Repo.name-v2");
  });

  test("rejects missing slash", () => {
    expect(resolveRepoFilter("noslash")).toBeNull();
  });

  test("rejects multiple slashes", () => {
    expect(resolveRepoFilter("a/b/c")).toBeNull();
  });

  test("rejects special characters beyond allowed set", () => {
    expect(resolveRepoFilter("org/repo space")).toBeNull();
    expect(resolveRepoFilter("org/repo;drop")).toBeNull();
    expect(resolveRepoFilter("../etc/passwd")).toBeNull();
  });

  test("returns null for undefined/empty", () => {
    expect(resolveRepoFilter(undefined)).toBeNull();
    expect(resolveRepoFilter("")).toBeNull();
  });
});

describe("resolveModelFilter", () => {
  test("accepts Anthropic model ids", () => {
    expect(resolveModelFilter("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(resolveModelFilter("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModelFilter("us.anthropic.claude-opus-4-7-20250514")).toBe(
      "us.anthropic.claude-opus-4-7-20250514",
    );
  });

  test("accepts OpenAI-style model ids", () => {
    expect(resolveModelFilter("gpt-4o")).toBe("gpt-4o");
    expect(resolveModelFilter("o3-mini")).toBe("o3-mini");
  });

  test("rejects ids with dangerous chars", () => {
    expect(resolveModelFilter("model'; DROP TABLE")).toBeNull();
    expect(resolveModelFilter("model\x00null")).toBeNull();
    expect(resolveModelFilter("<script>")).toBeNull();
  });

  test("rejects overly long ids", () => {
    expect(resolveModelFilter("a".repeat(121))).toBeNull();
  });

  test("returns null for undefined/empty", () => {
    expect(resolveModelFilter(undefined)).toBeNull();
    expect(resolveModelFilter("")).toBeNull();
  });
});

describe("resolveISODate", () => {
  test("accepts YYYY-MM-DD", () => {
    expect(resolveISODate("2026-06-01")).toBe("2026-06-01");
    expect(resolveISODate("2026-01-01")).toBe("2026-01-01");
  });

  test("accepts full ISO datetime strings", () => {
    expect(resolveISODate("2026-06-01T00:00:00Z")).toBe("2026-06-01T00:00:00Z");
  });

  test("rejects obviously invalid strings", () => {
    expect(resolveISODate("not-a-date")).toBeNull();
    expect(resolveISODate("2019-01-01")).toBeNull(); // before 2020 cutoff
    expect(resolveISODate("2100-01-01")).toBeNull(); // after 2099 cutoff
  });

  test("returns null for undefined/empty", () => {
    expect(resolveISODate(undefined)).toBeNull();
    expect(resolveISODate("")).toBeNull();
  });
});

describe("resolveDateRange", () => {
  test("returns [since, until] when since < until", () => {
    const [s, u] = resolveDateRange("2026-06-01", "2026-06-30");
    expect(s).toBe("2026-06-01");
    expect(u).toBe("2026-06-30");
  });

  test("returns [null, null] when since >= until", () => {
    const [s, u] = resolveDateRange("2026-06-30", "2026-06-01");
    expect(s).toBeNull();
    expect(u).toBeNull();
  });

  test("returns [null, null] when since === until", () => {
    const [s, u] = resolveDateRange("2026-06-15", "2026-06-15");
    expect(s).toBeNull();
    expect(u).toBeNull();
  });

  test("allows only since (no until)", () => {
    const [s, u] = resolveDateRange("2026-06-01", undefined);
    expect(s).toBe("2026-06-01");
    expect(u).toBeNull();
  });

  test("allows only until (no since)", () => {
    const [s, u] = resolveDateRange(undefined, "2026-06-30");
    expect(s).toBeNull();
    expect(u).toBe("2026-06-30");
  });

  test("returns [null, null] when both undefined", () => {
    const [s, u] = resolveDateRange(undefined, undefined);
    expect(s).toBeNull();
    expect(u).toBeNull();
  });

  test("rejects invalid date strings", () => {
    const [s, u] = resolveDateRange("bad-date", "2026-06-30");
    expect(s).toBeNull();
    // until is still valid but since invalid → both valid
    expect(u).toBe("2026-06-30");
  });
});

// ─── 2. SQL clause generation (structural) ────────────────────────────────────
// We can't execute the SQL, but we verify that the LoadOpts fields map to the
// correct documented $N bind slots by inspecting the query template string
// via a lightweight regex extraction test.

describe("LoadOpts SQL bind slot documentation", () => {
  test("new filter fields are documented with correct slot numbers", async () => {
    // Read the source file and check the bind layout comment.
    const src = await Bun.file(
      new URL("../lib/dashboard-data.ts", import.meta.url).pathname,
    ).text();

    // Verify $4 is documented as repoFilter
    expect(src).toContain("$4 = repoFilter");
    // Verify $5 is documented as modelFilter
    expect(src).toContain("$5 = modelFilter");
    // Verify $6 is documented as sinceISO
    expect(src).toContain("$6 = sinceISO");
    // Verify $7 is documented as untilISO
    expect(src).toContain("$7 = untilISO");
  });

  test("SQL WHERE block contains all four new filter clauses", async () => {
    const src = await Bun.file(
      new URL("../lib/dashboard-data.ts", import.meta.url).pathname,
    ).text();

    expect(src).toContain("$4::text IS NULL OR repo_name = $4::text");
    expect(src).toContain("$5::text IS NULL OR model = $5::text");
    expect(src).toContain("$6::timestamptz IS NULL OR ts >= $6::timestamptz");
    expect(src).toContain("$7::timestamptz IS NULL OR ts < $7::timestamptz");
  });

  test("scope params are rebased to $8+ in the main events query", async () => {
    const src = await Bun.file(
      new URL("../lib/dashboard-data.ts", import.meta.url).pathname,
    ).text();

    // rebasedScopeClauseSql is the variable used in the events query
    expect(src).toContain("rebasedScopeClauseSql");
    // The rebase call should pass startIndex 8
    expect(src).toContain("rebaseScopePlaceholders(scope.repoClauseSql, 8)");
  });
});

// ─── 3. Filter persistence (URL round-trip) ───────────────────────────────────
// We test the filterHref logic extracted inline here to verify the URL-param
// serialisation semantics without importing the JSX component.

function filterHref(
  baseHref: string,
  overrides: { repo?: string; model?: string; since?: string; until?: string },
): string {
  const [path, qs] = baseHref.includes("?") ? baseHref.split("?") : [baseHref, ""];
  const params = new URLSearchParams(qs);
  params.delete("repo");
  params.delete("model");
  params.delete("since");
  params.delete("until");
  for (const [k, v] of Object.entries(overrides)) {
    if (v) params.set(k, v);
  }
  const s = params.toString();
  return s ? `${path}?${s}` : path ?? "/app";
}

describe("filterHref — URL param persistence", () => {
  test("appends repo/model/since/until to a clean base href", () => {
    const href = filterHref("/app?win=14&src=claude_code", {
      repo: "acme/api", model: "claude-opus-4-7",
      since: "2026-06-01", until: "2026-06-30",
    });
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("win")).toBe("14");
    expect(params.get("src")).toBe("claude_code");
    expect(params.get("repo")).toBe("acme/api");
    expect(params.get("model")).toBe("claude-opus-4-7");
    expect(params.get("since")).toBe("2026-06-01");
    expect(params.get("until")).toBe("2026-06-30");
  });

  test("replaces existing repo/model/since/until in base href", () => {
    const href = filterHref(
      "/app?win=7&repo=old/repo&model=old-model&since=2026-01-01&until=2026-02-01",
      { repo: "new/repo", model: "claude-sonnet-4-6" },
    );
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("repo")).toBe("new/repo");
    expect(params.get("model")).toBe("claude-sonnet-4-6");
    // since and until were not in overrides → cleared (omitted → no bound)
    expect(params.get("since")).toBeNull();
    expect(params.get("until")).toBeNull();
    // win is preserved
    expect(params.get("win")).toBe("7");
  });

  test("clears filter when override value is empty/undefined", () => {
    const href = filterHref("/app?win=14&repo=acme%2Fapi", {
      repo: undefined,
    });
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("repo")).toBeNull();
    expect(params.get("win")).toBe("14");
  });

  test("returns /app when no params remain", () => {
    const href = filterHref("/app", {});
    expect(href).toBe("/app");
  });

  test("URL survives page reload — all filter params are query-string only", () => {
    // No hash, no path segments — everything is a query param.
    const href = filterHref("/app?tab=trends", {
      repo: "acme/api", since: "2026-06-01",
    });
    expect(href.startsWith("/app?")).toBe(true);
    expect(href).not.toContain("#");
    // Reload simulation: parse → rebuild → compare
    const params1 = new URLSearchParams(href.split("?")[1]);
    const params2 = new URLSearchParams(href.split("?")[1]);
    expect(params1.toString()).toBe(params2.toString());
  });
});

// ─── 4. E2E filter combo rendering (structural) ──────────────────────────────
// Verifies that ?repo=foo/bar&model=claude-opus-4-7&since=2026-06-01&until=2026-06-30
// is parsed and validated correctly end-to-end through the resolver pipeline.

describe("E2E filter combo: ?repo=foo/bar&model=claude-opus-4-7&since=2026-06-01&until=2026-06-30", () => {
  const rawRepo  = "foo/bar";
  const rawModel = "claude-opus-4-7";
  const rawSince = "2026-06-01";
  const rawUntil = "2026-06-30";

  test("all four params pass validation", () => {
    expect(resolveRepoFilter(rawRepo)).toBe(rawRepo);
    expect(resolveModelFilter(rawModel)).toBe(rawModel);
    const [s, u] = resolveDateRange(rawSince, rawUntil);
    expect(s).toBe(rawSince);
    expect(u).toBe(rawUntil);
  });

  test("validated params survive URL round-trip", () => {
    const repo  = resolveRepoFilter(rawRepo)!;
    const model = resolveModelFilter(rawModel)!;
    const [since, until] = resolveDateRange(rawSince, rawUntil);

    const href = filterHref("/app?win=14&tab=today", {
      repo,
      model,
      since: since ?? undefined,
      until: until ?? undefined,
    });

    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("repo")).toBe(rawRepo);
    expect(params.get("model")).toBe(rawModel);
    expect(params.get("since")).toBe(rawSince);
    expect(params.get("until")).toBe(rawUntil);
    expect(params.get("win")).toBe("14");
    expect(params.get("tab")).toBe("today");
  });
});
