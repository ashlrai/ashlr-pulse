/**
 * ActivityFeed — most-recent-N event list for the dashboard.
 *
 * Extracted from app/page.tsx; pure presentation component. Honors
 * peer-share field whitelist via the FeedRow shape (server filters
 * fields before passing them in — this component never sees redacted
 * data structurally, so renderers don't need to defend against it).
 */

import type { ReactElement } from "react";
import type { FeedRow } from "@/lib/dashboard-data";
import { palette } from "@/lib/theme";
import { fmtUsd } from "@/lib/pricing";
import { abbrev, fmtAgoShort } from "./dashboard-format";

export function ActivityFeed({ feed }: { feed: FeedRow[] }): ReactElement {
  if (feed.length === 0) {
    return <div style={{ color: palette.textMute, fontSize: 12 }}>No recent activity.</div>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 11 }}>
      {feed.map((r, i) => (
        <li
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "60px 70px 1fr 70px 60px",
            gap: 8,
            alignItems: "baseline",
            padding: "5px 0",
            borderBottom: `1px dashed ${palette.border}`,
          }}
        >
          <span style={{ color: palette.textMute, fontSize: 10 }}>
            {fmtAgoShort(new Date(r.ts))}
          </span>
          <span style={{ color: palette.cyan, fontSize: 10 }}>{r.source}</span>
          <span style={{ color: palette.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.repo ?? "—"}
            {r.model && <span style={{ color: palette.textDim, marginLeft: 8 }}>· {r.model}</span>}
            {r.tokens_cache != null && r.tokens_cache > 0 && (
              <span style={{ color: palette.textMute, marginLeft: 8, fontSize: 10 }}>
                + {abbrev(r.tokens_cache)} cache
              </span>
            )}
          </span>
          <span style={{ color: palette.textDim, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {abbrev((r.tokens_input ?? 0) + (r.tokens_output ?? 0))}
          </span>
          <span style={{ color: palette.magenta, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {fmtUsd(r.costCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}
