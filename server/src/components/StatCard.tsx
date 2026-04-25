/**
 * StatCard.tsx — minimal "headline number" card for the dashboard.
 *
 * Mirror the data densities Mason cares about: AI events, tokens, $,
 * commits, PRs. Variants render the same shell with different accents.
 */

import type { ReactElement } from "react";

export interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  accent?: "blue" | "green" | "purple" | "neutral";
}

const ACCENTS: Record<NonNullable<StatCardProps["accent"]>, string> = {
  blue:    "#0369a1",
  green:   "#15803d",
  purple:  "#7c3aed",
  neutral: "#374151",
};

export function StatCard({ label, value, hint, accent = "neutral" }: StatCardProps): ReactElement {
  return (
    <div
      style={{
        flex: "1 1 160px",
        minWidth: 160,
        padding: "16px 20px",
        background: "#fafafa",
        border: "1px solid #ececec",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          marginTop: 4,
          color: ACCENTS[accent],
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {hint && <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
