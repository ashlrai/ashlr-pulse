import { describe, expect, test } from "bun:test";
import { templatedBriefing } from "../src/lib/briefing";

describe("templatedBriefing", () => {
  test("notes baseline-stable activity", () => {
    const t = templatedBriefing({
      events: 100, tokens: 100_000, costCents: 5000,
      topRepos: [], topModels: [],
      baselineEvents: 100, baselineTokens: 100_000, baselineCostCents: 5000,
      commits: [],
    });
    expect(t).toMatch(/in line/);
  });

  test("notes a meaningful upward delta", () => {
    const t = templatedBriefing({
      events: 200, tokens: 200_000, costCents: 10_000,
      topRepos: [{ repo: "ashlr/api", events: 80 }],
      topModels: [],
      baselineEvents: 100, baselineTokens: 100_000, baselineCostCents: 5_000,
      commits: [],
    });
    expect(t).toMatch(/up/);
    expect(t).toMatch(/100%/);
    expect(t).toMatch(/ashlr\/api/);
  });

  test("notes a meaningful downward delta", () => {
    const t = templatedBriefing({
      events: 25, tokens: 25_000, costCents: 1_500,
      topRepos: [], topModels: [],
      baselineEvents: 100, baselineTokens: 100_000, baselineCostCents: 5_000,
      commits: [],
    });
    expect(t).toMatch(/down/);
  });

  test("includes peer line when peer is provided", () => {
    const t = templatedBriefing({
      events: 100, tokens: 100_000, costCents: null,
      topRepos: [], topModels: [],
      baselineEvents: 100, baselineTokens: 100_000, baselineCostCents: 0,
      commits: [],
      peer: { email: "kara@example.com", events: 40, tokens: 50_000, topRepos: ["a"] },
    });
    expect(t).toMatch(/kara@example\.com/);
    expect(t).toMatch(/40 events/);
  });

  test("renders without baseline (null cost)", () => {
    const t = templatedBriefing({
      events: 50, tokens: 50_000, costCents: null,
      topRepos: [], topModels: [],
      baselineEvents: 0, baselineTokens: 0, baselineCostCents: null,
      commits: [],
    });
    // baselineEvents=0 → no delta direction → "in line" branch returned
    expect(t.length).toBeGreaterThan(0);
  });
});
