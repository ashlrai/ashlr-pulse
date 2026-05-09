/**
 * BudgetBurndown.tsx — monthly budget progress bar with traffic-light coloring.
 *
 * Server-renderable: pure HTML + inline CSS, no chart library.
 * Traffic-light threshold: green < 70%, amber 70–90%, red > 90%.
 * A separate "time elapsed" underbar shows where we are in the month so
 * users can judge whether spend is ahead-of-pace or behind.
 */

import type { ReactElement } from "react";
import { palette, cardStyle, radius } from "@/lib/theme";

interface Props {
  budgetUsd:   number;
  spentUsd:    number;
  daysElapsed: number;
  daysInMonth: number;
}

function trafficColor(spentFrac: number): string {
  if (spentFrac >= 0.9) return palette.red;
  if (spentFrac >= 0.7) return palette.amber;
  return palette.green;
}

function ProgressBar({
  frac,
  color,
  label,
  sublabel,
}: {
  frac:     number;
  color:    string;
  label:    string;
  sublabel: string;
}): ReactElement {
  const pct = Math.min(frac * 100, 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11, color: palette.textDim, fontFamily: "var(--font-mono), monospace" }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color, fontFamily: "var(--font-mono), monospace", fontVariantNumeric: "tabular-nums" }}>
          {sublabel}
        </span>
      </div>
      <div
        style={{
          width:        "100%",
          height:       8,
          background:   palette.bgRaised,
          borderRadius: radius.sm,
          overflow:     "hidden",
          border:       `1px solid ${palette.border}`,
        }}
      >
        <div
          style={{
            width:        `${pct}%`,
            height:       "100%",
            background:   color,
            borderRadius: radius.sm,
            boxShadow:    `0 0 8px ${color}55`,
            transition:   "width 0.4s ease",
          }}
        />
      </div>
    </div>
  );
}

export function BudgetBurndown({
  budgetUsd,
  spentUsd,
  daysElapsed,
  daysInMonth,
}: Props): ReactElement {
  const spentFrac = budgetUsd > 0 ? spentUsd / budgetUsd : 0;
  const timeFrac  = daysInMonth > 0 ? daysElapsed / daysInMonth : 0;
  const barColor  = trafficColor(spentFrac);
  const remaining = Math.max(0, budgetUsd - spentUsd);

  // Pace indicator: are we spending faster than time elapsed?
  const paceRatio = timeFrac > 0 ? spentFrac / timeFrac : 0;
  const paceLabel =
    paceRatio > 1.15
      ? "ahead of pace"
      : paceRatio < 0.85
        ? "under pace"
        : "on pace";
  const paceColor =
    paceRatio > 1.15
      ? palette.red
      : paceRatio < 0.85
        ? palette.cyan
        : palette.green;

  return (
    <div style={{ ...cardStyle(), padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 12, color: palette.textDim, textTransform: "uppercase", letterSpacing: "0.7px", fontFamily: "var(--font-mono), monospace" }}>
          Monthly Budget
        </div>
        <div
          style={{
            fontSize:     10,
            color:        paceColor,
            background:   `${paceColor}18`,
            borderRadius: radius.sm,
            padding:      "2px 7px",
            fontFamily:   "var(--font-mono), monospace",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {paceLabel}
        </div>
      </div>

      {/* Spend amounts */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div
            style={{
              fontSize:           28,
              fontWeight:         700,
              color:              barColor,
              fontVariantNumeric: "tabular-nums",
              letterSpacing:      "-0.5px",
              lineHeight:         1,
            }}
          >
            ${spentUsd.toFixed(2)}
          </div>
          <div style={{ fontSize: 10, color: palette.textDim, marginTop: 4 }}>
            spent of ${budgetUsd.toFixed(2)} budget
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: palette.text, fontVariantNumeric: "tabular-nums" }}>
            ${remaining.toFixed(2)}
          </div>
          <div style={{ fontSize: 10, color: palette.textDim }}>remaining</div>
        </div>
      </div>

      {/* Spend progress bar */}
      <ProgressBar
        frac={spentFrac}
        color={barColor}
        label="spend"
        sublabel={`${(spentFrac * 100).toFixed(1)}%`}
      />

      {/* Time elapsed bar — gives context for pacing */}
      <ProgressBar
        frac={timeFrac}
        color={palette.textMute}
        label={`day ${daysElapsed} of ${daysInMonth}`}
        sublabel={`${(timeFrac * 100).toFixed(0)}% of month`}
      />
    </div>
  );
}
