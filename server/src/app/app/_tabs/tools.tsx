/**
 * Tools tab — placeholder.
 *
 * TODO: plug in ToolBreakdown chart from Phase 5 new chart components
 * (StackPanel, per-tool cost treemap, etc.) once they land.
 */

import type { ReactElement } from "react";

import { palette, space } from "@/lib/theme";

import type { TabProps } from "./types";

export function ToolsTab(_props: TabProps): ReactElement {
  return (
    <div style={{
      marginTop: space.x6,
      padding: space.x6,
      textAlign: "center",
      border: `1px dashed ${palette.border}`,
      borderRadius: 8,
      color: palette.textMute,
      fontSize: 13,
      lineHeight: 1.8,
    }}>
      <div style={{ fontSize: 16, color: palette.textDim, marginBottom: space.x2 }}>
        More tool analytics coming soon
      </div>
      <div>
        Per-tool cost breakdown, call frequency heatmap, and error rates are being built
        as part of Phase 5 chart components.
      </div>
    </div>
  );
}
