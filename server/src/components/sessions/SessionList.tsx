/**
 * SessionList.tsx — client component: renders the paginated sessions table.
 *
 * Each row links to /sessions/[id] for the flamegraph detail view.
 */

"use client";

import type { ReactElement } from "react";
import type { SessionSummary } from "@/app/sessions/page";
import { palette, space, font, radius } from "@/lib/theme";

interface Props {
  sessions: SessionSummary[];
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function fmtCost(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`;
}

function shortModel(m: string | null): string {
  if (!m) return "—";
  return m.replace(/^claude-/i, "").replace(/-\d{8}$/, "");
}

export function SessionList({ sessions }: Props): ReactElement {
  if (sessions.length === 0) {
    return (
      <p style={{ fontSize: 12, color: palette.textMute, padding: `${space.x4}px 0` }}>
        No sessions found. Claude Code sessions appear here once OTel spans with{" "}
        <code style={{ fontFamily: font.mono }}>claude.session.id</code> are ingested.
      </p>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
          fontFamily: font.mono,
        }}
      >
        <thead>
          <tr>
            {["Session", "Start", "Repo", "Model", "Spans", "Duration", "Tokens", "Cost"].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: `${space.x1}px ${space.x2}px`,
                  color: palette.textMute,
                  fontWeight: 500,
                  fontSize: 11,
                  borderBottom: `1px solid ${palette.border}`,
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={s.sessionId}
              style={{ cursor: "pointer" }}
              onClick={() => { window.location.href = `/sessions/${encodeURIComponent(s.sessionId)}`; }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = palette.bgRaised;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = "";
              }}
            >
              <td
                style={{
                  padding: `${space.x1}px ${space.x2}px`,
                  color: palette.cyan,
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <a
                  href={`/sessions/${encodeURIComponent(s.sessionId)}`}
                  style={{ color: "inherit", textDecoration: "none" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {s.sessionId.slice(0, 20)}{s.sessionId.length > 20 ? "…" : ""}
                </a>
              </td>
              <td style={{ padding: `${space.x1}px ${space.x2}px`, color: palette.textDim, whiteSpace: "nowrap" }}>
                {new Date(s.startTs).toLocaleString(undefined, {
                  month: "short", day: "numeric",
                  hour: "2-digit", minute: "2-digit",
                })}
              </td>
              <td style={{ padding: `${space.x1}px ${space.x2}px`, color: palette.textDim, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.repo ?? "—"}
              </td>
              <td style={{ padding: `${space.x1}px ${space.x2}px`, color: palette.textDim }}>
                {shortModel(s.model)}
              </td>
              <td style={{ padding: `${space.x1}px ${space.x2}px`, color: palette.textDim, textAlign: "right" }}>
                {s.spanCount}
              </td>
              <td style={{ padding: `${space.x1}px ${space.x2}px`, color: palette.textDim, textAlign: "right" }}>
                {fmtDuration(s.totalLatencyMs)}
              </td>
              <td style={{ padding: `${space.x1}px ${space.x2}px`, color: palette.textDim, textAlign: "right" }}>
                {fmtTokens(s.totalTokens)}
              </td>
              <td
                style={{
                  padding: `${space.x1}px ${space.x2}px`,
                  color: s.totalCostCents > 500 ? palette.amber : palette.green,
                  textAlign: "right",
                  fontWeight: 500,
                }}
              >
                {fmtCost(s.totalCostCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Suppress unused import warning for radius — it's available if needed
void radius;
