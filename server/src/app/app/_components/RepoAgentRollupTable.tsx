/**
 * RepoAgentRollupTable — compact engineering scoreboard by repository.
 *
 * Shows the core team question in one scan: where agentic engineering
 * time is going, whether that time is Claude Code or Codex, and how it
 * lines up with GitHub output.
 */

import type { ReactElement } from "react";

import type { RepoAgentRollup } from "@/lib/dashboard-data";
import { fmtUsd } from "@/lib/pricing";
import { palette, sourceColor } from "@/lib/theme";

import { abbrev, th, td } from "./dashboard-format";

interface Props {
  rows: RepoAgentRollup[];
}

export function RepoAgentRollupTable({ rows }: Props): ReactElement {
  if (rows.length === 0) {
    return (
      <div style={{ color: palette.textMute, fontSize: 13, padding: "10px 0" }}>
        No repo-attributed agent activity in this window.
      </div>
    );
  }

  const maxMinutes = Math.max(...rows.map((r) => r.totalMinutes), 1);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${palette.border}` }}>
            <th style={{ ...th, textAlign: "left" }}>repo</th>
            <th style={{ ...th, textAlign: "right" }}>active time</th>
            <th style={{ ...th, textAlign: "left", minWidth: 160 }}>mix</th>
            <th style={{ ...th, textAlign: "right" }}>events</th>
            <th style={{ ...th, textAlign: "right" }}>tokens</th>
            <th style={{ ...th, textAlign: "right" }}>cost</th>
            <th style={{ ...th, textAlign: "right" }}>commits</th>
            <th style={{ ...th, textAlign: "right" }}>prs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const events = r.claudeEvents + r.codexEvents + r.otherEvents;
            const prs = r.prsOpened + r.prsMerged;
            return (
              <tr key={r.repo} style={{ borderBottom: `1px solid ${palette.border}` }}>
                <td style={{ ...td, color: palette.textDim, maxWidth: 260 }}>
                  <span style={{ color: palette.text, fontWeight: 500 }}>{shortRepo(r.repo)}</span>
                  <div style={{ color: palette.textMute, fontSize: 10, marginTop: 2 }}>{r.repo}</div>
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {fmtActiveTime(r.totalMinutes)}
                </td>
                <td style={{ ...td, minWidth: 160 }}>
                  <AgentMixBar row={r} maxMinutes={maxMinutes} />
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: sourceColor.claude_code }}>{r.claudeEvents}</span>
                  <span style={{ color: palette.textMute }}> / </span>
                  <span style={{ color: sourceColor.codex }}>{r.codexEvents}</span>
                  {r.otherEvents > 0 && <span style={{ color: palette.textMute }}> / {r.otherEvents}</span>}
                  <div style={{ color: palette.textMute, fontSize: 10 }}>{events} total</div>
                </td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{abbrev(r.tokens)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtUsd(r.costCents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.commits}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {prs}
                  <div style={{ color: palette.textMute, fontSize: 10 }}>{r.prsMerged} merged</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 14, marginTop: 10, color: palette.textMute, fontSize: 11 }}>
        <LegendDot color={sourceColor.claude_code} label="Claude Code" />
        <LegendDot color={sourceColor.codex} label="Codex" />
        <LegendDot color={palette.textMute} label="other sources" />
      </div>
    </div>
  );
}

function AgentMixBar({ row, maxMinutes }: { row: RepoAgentRollup; maxMinutes: number }): ReactElement {
  const widthPct = Math.max(3, (row.totalMinutes / maxMinutes) * 100);
  const claudePct = row.totalMinutes > 0 ? (row.claudeMinutes / row.totalMinutes) * 100 : 0;
  const codexPct = row.totalMinutes > 0 ? (row.codexMinutes / row.totalMinutes) * 100 : 0;
  const otherPct = row.totalMinutes > 0 ? (row.otherMinutes / row.totalMinutes) * 100 : Math.max(0, 100 - claudePct - codexPct);
  return (
    <div style={{ width: "100%", height: 12, background: palette.bgRaised, border: `1px solid ${palette.border}`, borderRadius: 4, overflow: "hidden" }}>
      <div style={{ width: `${widthPct}%`, height: "100%", display: "flex" }}>
        <div style={{ width: `${claudePct}%`, background: sourceColor.claude_code }} />
        <div style={{ width: `${codexPct}%`, background: sourceColor.codex }} />
        {otherPct > 0 && <div style={{ width: `${otherPct}%`, background: palette.textMute, opacity: 0.5 }} />}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): ReactElement {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}

function shortRepo(repo: string): string {
  const parts = repo.split("/");
  return parts.length > 1 ? parts[parts.length - 1] : repo;
}

function fmtActiveTime(minutes: number): string {
  if (minutes >= 60) return `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
  return `${minutes.toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
}
