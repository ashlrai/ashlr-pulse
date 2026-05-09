/**
 * Tools tab — concrete per-tool analytics.
 *
 * Uses only curated activity_event metadata: tool type labels, model,
 * source, repo, token counts, and durations. No prompts, command args,
 * stdout, or code content are read or rendered here.
 */

import type { ReactElement } from "react";

import { HBarChart } from "@/components/charts/HBarChart";
import { ToolModelHeatmap } from "@/components/charts/ToolModelHeatmap";
import { Card, CardHeader } from "@/components/ui/Card";
import { palette, space } from "@/lib/theme";

import { RepoAgentRollupTable } from "../_components/RepoAgentRollupTable";

import type { TabProps } from "./types";

export function ToolsTab({ data, isOwnView }: TabProps): ReactElement {
  const hasTools = data.topTools.length > 0;
  const hasMatrix = data.toolModelMatrix.rows.length > 0 && data.toolModelMatrix.cols.length > 0;
  const hasRepos = data.repoAgentRollup.length > 0;

  if (!hasTools && !hasMatrix && !hasRepos) {
    return (
      <Card style={{ marginTop: space.x6, textAlign: "center", borderStyle: "dashed" }}>
        <div style={{ color: palette.textDim, fontSize: 16, marginBottom: space.x2 }}>
          No tool-call analytics yet
        </div>
        <div style={{ color: palette.textMute, fontSize: 13, lineHeight: 1.7 }}>
          Tool charts appear once Claude Code, Codex, or another source emits safe tool-call metadata.
        </div>
      </Card>
    );
  }

  return (
    <div style={{ marginTop: space.x6, display: "grid", gap: space.x5 }}>
      <div className="dash-grid">
        <Card accent={palette.cyan}>
          <CardHeader
            title={`top tool calls · last ${data.chartDays}d`}
            hint="count by sanitized tool type"
          />
          {hasTools ? (
            <HBarChart data={data.topTools} rowHeight={30} uniformColor={palette.cyan} />
          ) : (
            <EmptyLine>No named tool calls in this window.</EmptyLine>
          )}
        </Card>

        <Card accent={palette.green}>
          <CardHeader
            title="tool x model intensity"
            hint="which models are driving each tool category"
          />
          {hasMatrix ? (
            <ToolModelHeatmap
              rows={data.toolModelMatrix.rows}
              cols={data.toolModelMatrix.cols}
              cells={data.toolModelMatrix.cells}
              valueLabel="tool calls"
            />
          ) : (
            <EmptyLine>No model-attributed tool calls in this window.</EmptyLine>
          )}
        </Card>
      </div>

      {hasRepos && (
        <Card accent={palette.purple}>
          <CardHeader
            title={`repo x agent execution · last ${data.chartDays}d`}
            hint="where Claude Code and Codex are spending time, paired with GitHub output"
            right={isOwnView ? <a href="/share" style={{ color: palette.cyan, textDecoration: "none" }}>invite teammate →</a> : undefined}
          />
          <RepoAgentRollupTable rows={data.repoAgentRollup} />
        </Card>
      )}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div style={{ color: palette.textMute, fontSize: 13, padding: "10px 0" }}>
      {children}
    </div>
  );
}
