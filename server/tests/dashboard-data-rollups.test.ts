import { describe, expect, test } from "bun:test";

import {
  computeActiveMinutesByRepoSource,
  mergeCommitRollups,
  selectDashboardGitHubState,
} from "../src/lib/dashboard-data";

describe("dashboard active-time rollups", () => {
  test("falls back to active windows when duration_ms is null", () => {
    const now = Date.parse("2026-05-09T12:00:00.000Z");
    const rollup = computeActiveMinutesByRepoSource([
      { repo_name: "ashlr/pulse", source: "codex", ts: "2026-05-09T11:50:00.000Z", duration_ms: null },
      { repo_name: "ashlr/pulse", source: "codex", ts: "2026-05-09T11:55:00.000Z", duration_ms: null },
    ], now, 7);

    expect(rollup.get("ashlr/pulse")?.get("codex")).toBe(6);
  });

  test("prefers valid duration_ms when present", () => {
    const now = Date.parse("2026-05-09T12:00:00.000Z");
    const rollup = computeActiveMinutesByRepoSource([
      { repo_name: "ashlr/pulse", source: "claude_code", ts: "2026-05-09T11:50:00.000Z", duration_ms: 120_000 },
      { repo_name: "ashlr/pulse", source: "claude_code", ts: "2026-05-09T11:51:00.000Z", duration_ms: 180_000 },
    ], now, 7);

    expect(rollup.get("ashlr/pulse")?.get("claude_code")).toBe(5);
  });

  test("caps idle gaps so long breaks do not inflate time", () => {
    const now = Date.parse("2026-05-09T12:00:00.000Z");
    const rollup = computeActiveMinutesByRepoSource([
      { repo_name: "ashlr/pulse", source: "codex", ts: "2026-05-09T10:00:00.000Z", duration_ms: null },
      { repo_name: "ashlr/pulse", source: "codex", ts: "2026-05-09T11:00:00.000Z", duration_ms: null },
    ], now, 7);

    expect(rollup.get("ashlr/pulse")?.get("codex")).toBe(11);
  });

  test("does not treat agent git commit spans as active time", () => {
    const now = Date.parse("2026-05-09T12:00:00.000Z");
    const rollup = computeActiveMinutesByRepoSource([
      { repo_name: "ashlr/pulse", source: "git", ts: "2026-05-09T11:50:00.000Z", duration_ms: null },
    ], now, 7);

    expect(rollup.size).toBe(0);
  });
});

describe("dashboard commit rollups", () => {
  test("uses GitHub commits when present", () => {
    const rollup = mergeCommitRollups({
      githubCommits: [
        { repo: "ashlr/pulse", ts: "2026-05-09T10:00:00.000Z" },
        { repo: "ashlr/pulse", ts: "2026-05-09T11:00:00.000Z" },
      ],
      agentGitCommits: [],
    });

    expect(rollup.totalCommits).toBe(2);
    expect(rollup.commitsByRepo.get("ashlr/pulse")).toBe(2);
    expect(rollup.commitsByDay.get("2026-05-09")).toBe(2);
  });

  test("uses agent git commits when GitHub is absent for a repo-day", () => {
    const rollup = mergeCommitRollups({
      githubCommits: [],
      agentGitCommits: [
        { repo: "ashlr/pulse", ts: "2026-05-09T10:00:00.000Z" },
        { repo: "ashlr/pulse", ts: "2026-05-09T11:00:00.000Z" },
      ],
    });

    expect(rollup.totalCommits).toBe(2);
    expect(rollup.githubCommits).toBe(0);
    expect(rollup.agentGitCommits).toBe(2);
  });

  test("does not double count agent git when GitHub has the same repo-day", () => {
    const rollup = mergeCommitRollups({
      githubCommits: [
        { repo: "ashlr/pulse", ts: "2026-05-09T10:00:00.000Z" },
      ],
      agentGitCommits: [
        { repo: "ashlr/pulse", ts: "2026-05-09T11:00:00.000Z" },
        { repo: "ashlr/agent", ts: "2026-05-09T11:00:00.000Z" },
      ],
    });

    expect(rollup.totalCommits).toBe(2);
    expect(rollup.commitsByRepo.get("ashlr/pulse")).toBe(1);
    expect(rollup.commitsByRepo.get("ashlr/agent")).toBe(1);
  });
});

describe("dashboard GitHub state", () => {
  test("selects missing_or_stale when agent git has commits but GitHub has none", () => {
    expect(selectDashboardGitHubState({
      githubCommitCount: 0,
      githubEventCount: 0,
      agentGitCommitCount: 3,
      repoActivityCount: 4,
    })).toBe("missing_or_stale");
  });

  test("selects ready when GitHub events are present", () => {
    expect(selectDashboardGitHubState({
      githubCommitCount: 0,
      githubEventCount: 1,
      agentGitCommitCount: 3,
      repoActivityCount: 4,
    })).toBe("ready");
  });

  test("selects empty when no repo or git activity exists", () => {
    expect(selectDashboardGitHubState({
      githubCommitCount: 0,
      githubEventCount: 0,
      agentGitCommitCount: 0,
      repoActivityCount: 0,
    })).toBe("empty");
  });
});
