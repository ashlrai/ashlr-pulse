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
  const hasSourceMix = data.repoSourceMix.length > 0;

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
            <EmptyLine>No named tool calls in this window. Some sources report event and token metadata without safe per-tool labels.</EmptyLine>
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
            <EmptyLine>No model-attributed tool calls in this window. Coverage depends on sources emitting sanitized tool-call metadata.</EmptyLine>
          )}
        </Card>
      </div>

      {hasSourceMix && (
        <Card accent={palette.green}>
          <CardHeader
            title={`repo source mix · last ${data.chartDays}d`}
            hint="active-time split by Claude Code, Codex, and other sources"
          />
          <RepoSourceMix rows={data.repoSourceMix} />
        </Card>
      )}

      {hasRepos && (
        <Card accent={palette.purple}>
          <CardHeader
            title={`repo x agent execution · last ${data.chartDays}d`}
            hint="where Claude Code and Codex are spending active time, paired with Git/GitHub output"
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

function RepoSourceMix({
  rows,
}: { rows: { repo: string; claudeMinutes: number; codexMinutes: number; otherMinutes: number }[] }): ReactElement {
  return (
    <div style={{ display: "grid", gap: 10, marginTop: space.x2 }}>
      {rows.map((r) => {
        const total = r.claudeMinutes + r.codexMinutes + r.otherMinutes;
        const claudePct = total > 0 ? (r.claudeMinutes / total) * 100 : 0;
        const codexPct = total > 0 ? (r.codexMinutes / total) * 100 : 0;
        const otherPct = total > 0 ? (r.otherMinutes / total) * 100 : 0;
        return (
          <div key={r.repo} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 240px) 1fr auto", gap: 12, alignItems: "center" }}>
            <div style={{ minWidth: 0, color: palette.text, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.repo}</div>
            <div style={{ height: 12, borderRadius: 4, border: `1px solid ${palette.border}`, background: palette.bgRaised, overflow: "hidden", display: "flex" }}>
              <div style={{ width: `${claudePct}%`, background: palette.green }} />
              <div style={{ width: `${codexPct}%`, background: "#7DFFB3", opacity: 0.75 }} />
              <div style={{ width: `${otherPct}%`, background: palette.textMute, opacity: 0.5 }} />
            </div>
            <div style={{ color: palette.textMute, fontSize: 10, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmtActiveTime(total)}</div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 14, color: palette.textMute, fontSize: 10 }}>
        <span><span style={{ color: palette.green }}>■</span> Claude Code</span>
        <span><span style={{ color: "#7DFFB3" }}>■</span> Codex</span>
        <span><span style={{ color: palette.textMute }}>■</span> other</span>
      </div>
    </div>
  );
}

function fmtActiveTime(minutes: number): string {
  if (minutes >= 60) return `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
  return `${minutes.toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
}
