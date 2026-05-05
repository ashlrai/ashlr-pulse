/**
 * ProjectRollupTable — per-project breakdown row for the dashboard.
 *
 * Extracted from app/page.tsx; pure presentation component. Loads no
 * data; the parent page passes already-aggregated rows from
 * `lib/dashboard-data#ProjectRollup[]`.
 */

import type { ReactElement } from "react";
import type { ProjectRollup } from "@/lib/dashboard-data";
import { palette } from "@/lib/theme";
import { fmtUsd } from "@/lib/pricing";
import { abbrev, kindColor, kindChip, th, td } from "./dashboard-format";

export function ProjectRollupTable({ rows }: { rows: ProjectRollup[] }): ReactElement {
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
          <th style={th}>project</th>
          <th style={th}>kind</th>
          <th style={{ ...th, textAlign: "right" }}>repos</th>
          <th style={{ ...th, textAlign: "right" }}>events</th>
          <th style={{ ...th, textAlign: "right" }}>tokens</th>
          <th style={{ ...th, textAlign: "right" }}>cost</th>
          <th style={{ ...th, width: "25%" }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.project_id} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={td}>
              <span style={{ color: palette.text, fontWeight: 500 }}>{r.project_name}</span>
            </td>
            <td style={td}>
              <span style={kindChip(r.kind)}>{r.kind}</span>
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim }}>{r.repos}</td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
              {r.events.toLocaleString()}
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
              {abbrev(r.tokens)}
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.magenta, fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(r.cents)}
            </td>
            <td style={td}>
              <div style={{ height: 6, background: palette.bgRaised, borderRadius: 3, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, (r.tokens / max) * 100)}%`,
                    background: kindColor(r.kind),
                    transition: "width 0.5s ease",
                  }}
                />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
