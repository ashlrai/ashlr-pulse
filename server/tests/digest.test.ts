/**
 * digest.test.ts — coverage for the pure pieces of the digest pipeline.
 *
 * The DB-touching pieces (loadActivity, buildDigest end-to-end, pickDueUsers)
 * are exercised by the curl smoke test in QUICKSTART; here we lock down the
 * tricky time-zone math + grant gating + renderer output, which is where
 * regressions silently break the cron at 9am UTC.
 */

import { describe, expect, test } from "bun:test";
import {
  alreadySentToday,
  grantFires,
  localCalendar,
  localHour,
  yesterdayWindow,
} from "../src/lib/digest";
import { renderDigestEmail } from "../src/lib/digest-render";
import type { DigestPayload } from "../src/lib/digest";

describe("yesterdayWindow", () => {
  test("UTC: at 2026-04-25T05:00Z, yesterday is 2026-04-24 00:00Z–2026-04-25 00:00Z", () => {
    const now = new Date("2026-04-25T05:00:00Z");
    const w = yesterdayWindow("UTC", now);
    expect(w.startUtc).toBe("2026-04-24T00:00:00.000Z");
    expect(w.endUtc).toBe("2026-04-25T00:00:00.000Z");
    expect(w.label).toMatch(/Apr 24/);
  });

  test("America/Los_Angeles: at 2026-04-25T05:00Z (still Apr 24 PT), yesterday is Apr 23 in PT", () => {
    // 05:00Z is 22:00 PDT on Apr 24. Local 'today' = Apr 24, so yesterday = Apr 23.
    const now = new Date("2026-04-25T05:00:00Z");
    const w = yesterdayWindow("America/Los_Angeles", now);
    // Apr 23 00:00 PDT = Apr 23 07:00 UTC
    expect(w.startUtc).toBe("2026-04-23T07:00:00.000Z");
    expect(w.endUtc).toBe("2026-04-24T07:00:00.000Z");
    expect(w.label).toMatch(/Apr 23/);
  });

  test("America/Los_Angeles: at 2026-04-25T15:00Z (08:00 PDT Apr 25), yesterday is Apr 24", () => {
    const now = new Date("2026-04-25T15:00:00Z");
    const w = yesterdayWindow("America/Los_Angeles", now);
    expect(w.startUtc).toBe("2026-04-24T07:00:00.000Z");
    expect(w.endUtc).toBe("2026-04-25T07:00:00.000Z");
    expect(w.label).toMatch(/Apr 24/);
  });
});

describe("localHour", () => {
  test("UTC: 2026-04-25T09:00Z → 9", () => {
    expect(localHour("UTC", new Date("2026-04-25T09:00:00Z"))).toBe(9);
  });
  test("America/Los_Angeles: 2026-04-25T16:00Z → 9 (during PDT)", () => {
    expect(localHour("America/Los_Angeles", new Date("2026-04-25T16:00:00Z"))).toBe(9);
  });
  test("Asia/Tokyo: 2026-04-25T00:00Z → 9", () => {
    expect(localHour("Asia/Tokyo", new Date("2026-04-25T00:00:00Z"))).toBe(9);
  });
});

describe("localCalendar", () => {
  test("UTC: Apr 25 2026 is a Saturday (dow=6), dom=25", () => {
    const c = localCalendar("UTC", new Date("2026-04-25T12:00:00Z"));
    expect(c.dow).toBe(6);
    expect(c.dom).toBe(25);
  });
  test("Apr 27 2026 is a Monday — dow=1", () => {
    const c = localCalendar("UTC", new Date("2026-04-27T12:00:00Z"));
    expect(c.dow).toBe(1);
  });
  test("dom rolls into next month at midnight in user TZ", () => {
    // 2026-05-01 00:30 PDT = 2026-05-01 07:30 UTC, but at 06:00 UTC it's still Apr 30 23:00 PDT.
    const cBefore = localCalendar("America/Los_Angeles", new Date("2026-05-01T06:00:00Z"));
    expect(cBefore.dom).toBe(30);
    const cAfter = localCalendar("America/Los_Angeles", new Date("2026-05-01T08:00:00Z"));
    expect(cAfter.dom).toBe(1);
  });
});

describe("grantFires", () => {
  test("realtime + daily fire every day", () => {
    const wed = { dow: 3, dom: 15 };
    expect(grantFires("realtime", wed)).toBe(true);
    expect(grantFires("daily", wed)).toBe(true);
  });
  test("weekly fires on Monday only", () => {
    expect(grantFires("weekly", { dow: 1, dom: 5 })).toBe(true);
    expect(grantFires("weekly", { dow: 0, dom: 5 })).toBe(false);
    expect(grantFires("weekly", { dow: 5, dom: 5 })).toBe(false);
  });
  test("monthly fires on the 1st only", () => {
    expect(grantFires("monthly", { dow: 3, dom: 1 })).toBe(true);
    expect(grantFires("monthly", { dow: 3, dom: 2 })).toBe(false);
    expect(grantFires("monthly", { dow: 0, dom: 28 })).toBe(false);
  });
});

describe("alreadySentToday", () => {
  const tz = "America/Los_Angeles";
  // 2026-04-25 09:00 PDT = 2026-04-25 16:00 UTC.
  const at0930PDT = new Date("2026-04-25T16:30:00Z");

  test("never sent → false", () => {
    expect(alreadySentToday(null, tz, at0930PDT)).toBe(false);
  });
  test("sent 5 min ago → true", () => {
    expect(alreadySentToday("2026-04-25T16:25:00Z", tz, at0930PDT)).toBe(true);
  });
  test("sent yesterday afternoon → false (it was before today's 9am)", () => {
    expect(alreadySentToday("2026-04-24T22:00:00Z", tz, at0930PDT)).toBe(false);
  });
  test("sent at exactly today's 9am → true", () => {
    expect(alreadySentToday("2026-04-25T16:00:00Z", tz, at0930PDT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const emptyPayload: DigestPayload = {
  user_id: "u1",
  email: "mason@evero.test",
  dateLabel: "Fri, Apr 24",
  self: { bySource: [], byRepo: [], byProject: [], github: { commits: 0, prs_opened: 0, prs_merged: 0 }, missedRepos: [] },
  peers: [],
  empty: true,
};

const fullPayload: DigestPayload = {
  user_id: "u1",
  email: "mason@evero.test",
  dateLabel: "Fri, Apr 24",
  self: {
    bySource: [
      { source: "claude_code", events: 18, tokens: 1_240_000, cents: 850 },
      { source: "git",         events: 6,  tokens: 0,         cents: 0   },
    ],
    byRepo: [
      { repo: "ashlr/pulse",   events: 14, tokens: 980_000,   cents: 700 },
      { repo: "ashlr/cotidie", events: 4,  tokens: 260_000,   cents: 150 },
    ],
    byProject: [],
    github: { commits: 6, prs_opened: 1, prs_merged: 1 },
    missedRepos: ["ashlr/legacy-tool"],
  },
  peers: [
    {
      owner_id: "u2",
      owner_email: "co@evero.test",
      totals: { events: 9, tokens: 500_000, cents: 320, repos: 1, tools: 1 },
      bySource: [{ source: "claude_code", events: 9, tokens: 500_000, cents: 320 }],
      byRepo: [{ repo: "ashlr/cotidie", events: 9, tokens: 500_000, cents: 320 }],
      byProject: [],
      showCost: true,
    },
  ],
  empty: false,
};

describe("renderDigestEmail", () => {
  test("empty day produces a 'quiet day' subject + body", () => {
    const r = renderDigestEmail(emptyPayload);
    expect(r.subject).toMatch(/quiet day/);
    expect(r.text).toMatch(/Quiet day/);
    expect(r.html).toMatch(/Quiet day/);
  });

  test("full day subject includes tokens, cost, peer count", () => {
    const r = renderDigestEmail(fullPayload);
    expect(r.subject).toMatch(/1\.24M tok/);
    expect(r.subject).toMatch(/\$8\.50/);
    expect(r.subject).toMatch(/\+1 peer/);
  });

  test("text body includes self repos, github line, and warn", () => {
    const r = renderDigestEmail(fullPayload);
    expect(r.text).toMatch(/ashlr\/pulse/);
    expect(r.text).toMatch(/6 commits, 1 PRs opened, 1 merged/);
    expect(r.text).toMatch(/ashlr\/legacy-tool/);
    expect(r.text).toMatch(/co@evero\.test/);
  });

  test("html body escapes user-controlled strings", () => {
    const evil: DigestPayload = {
      ...fullPayload,
      peers: [{ ...fullPayload.peers[0], owner_email: "<script>alert(1)</script>@x" }],
    };
    const r = renderDigestEmail(evil);
    expect(r.html).not.toMatch(/<script>alert/);
    expect(r.html).toMatch(/&lt;script&gt;/);
  });

  test("peer with showCost=false omits cost columns and cents", () => {
    const noCost: DigestPayload = {
      ...fullPayload,
      peers: [{ ...fullPayload.peers[0], showCost: false }],
    };
    const r = renderDigestEmail(noCost);
    // cost column header absent for this peer
    const peerSlice = r.html.split("Peers")[1] ?? "";
    expect(peerSlice).not.toMatch(/<th class="num">cost<\/th>/);
  });

  test("peer summary line surfaces totals derived from authorized fields", () => {
    const r = renderDigestEmail(fullPayload);
    // Text: peer's "9 events · ... · 1 repo · 1 tool"
    expect(r.text).toMatch(/9 events/);
    expect(r.text).toMatch(/1 repo/);
    expect(r.text).toMatch(/1 tool/);
    // HTML: same summary in the peer panel
    expect(r.html).toMatch(/peer-summary/);
    expect(r.html).toMatch(/9 events/);
  });

  test("peer with byProject renders a project rollup table", () => {
    const withProject: DigestPayload = {
      ...fullPayload,
      peers: [
        {
          ...fullPayload.peers[0],
          byProject: [
            {
              project_id: "p1",
              project_name: "client-foo",
              repos: [{ repo: "ashlr/cotidie", events: 9, tokens: 500_000, cents: 320 }],
              events: 9,
              tokens: 500_000,
              cents: 320,
            },
          ],
        },
      ],
    };
    const r = renderDigestEmail(withProject);
    expect(r.text).toMatch(/projects:/);
    expect(r.text).toMatch(/client-foo/);
    expect(r.html).toMatch(/client-foo/);
  });

  test("peer with showCost=false zeroes tokens/cents in totals line", () => {
    const noCost: DigestPayload = {
      ...fullPayload,
      peers: [
        {
          ...fullPayload.peers[0],
          showCost: false,
          totals: { events: 9, tokens: 0, cents: null, repos: 1, tools: 1 },
        },
      ],
    };
    const r = renderDigestEmail(noCost);
    // Summary line still includes events/repos/tools but no token/cost figures.
    expect(r.text).toMatch(/9 events/);
    expect(r.text).not.toMatch(/500\.0k tok/);
    expect(r.text).not.toMatch(/\$3\.20/);
  });
});
