/**
 * AnomalyBadge.tsx — small inline severity chip for annotating anomalous points.
 *
 * Server-renderable. Positioned absolutely when x/y are provided, so the
 * parent must be position:relative. The badge can also be used inline
 * (no x/y) as a table cell annotation or legend item.
 */

import type { ReactElement } from "react";
import { palette, radius } from "@/lib/theme";

type Severity = "info" | "warn" | "crit";

interface Props {
  label:     string;
  severity?: Severity;
  /** Absolute x offset from parent container (px). */
  x?:        number;
  /** Absolute y offset from parent container (px). */
  y?:        number;
}

function severityColor(s: Severity): string {
  if (s === "crit") return palette.red;
  if (s === "warn") return palette.amber;
  return palette.cyan;
}

function severityIcon(s: Severity): string {
  if (s === "crit") return "●";
  if (s === "warn") return "▲";
  return "◆";
}

export function AnomalyBadge({ label, severity = "info", x, y }: Props): ReactElement {
  const color = severityColor(severity);
  const icon  = severityIcon(severity);

  const positionStyle: React.CSSProperties =
    x != null && y != null
      ? { position: "absolute", left: x, top: y, zIndex: 10 }
      : {};

  return (
    <div
      style={{
        ...positionStyle,
        display:       "inline-flex",
        alignItems:    "center",
        gap:           4,
        fontSize:      10,
        fontFamily:    "var(--font-mono), monospace",
        color,
        background:    `${color}1a`,
        border:        `1px solid ${color}44`,
        borderRadius:  radius.md,
        padding:       "2px 7px",
        letterSpacing: "0.3px",
        whiteSpace:    "nowrap",
        boxShadow:     `0 0 8px ${color}22`,
        pointerEvents: "none",
      }}
    >
      <span style={{ fontSize: 7, lineHeight: 1 }}>{icon}</span>
      {label}
    </div>
  );
}
