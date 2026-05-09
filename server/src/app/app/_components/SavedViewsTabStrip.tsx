/**
 * SavedViewsTabStrip — renders the "All" tab plus any named saved views.
 *
 * Extracted from page.tsx during the tab-routing refactor so the shell
 * stays under 400 lines. Behaviour is identical to the original inline
 * version.
 */

import type { ReactElement } from "react";

import { palette, space } from "@/lib/theme";
import { type DashboardView, viewToHref } from "@/lib/dashboard-view-db";

export function SavedViewsTabStrip({
  views,
  currentWin,
}: { views: DashboardView[]; currentWin: string }): ReactElement {
  // "All" is implicit — always present, leftmost, links to /app with no
  // overrides so it cleanly resets state.
  const tabs = [
    {
      label: "All",
      href: "/app",
      active:
        views.every((v) => v.filter.win !== currentWin) && currentWin === "14",
    },
    ...views.map((v) => ({
      label: v.name,
      href: viewToHref(v.filter),
      active: false,
      // No reliable way to know which view is currently active without
      // diffing all filter dims; the user re-clicks to switch.
    })),
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.x2, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <a
          key={t.label + t.href}
          href={t.href}
          style={{
            fontSize: 11,
            padding: "4px 10px",
            border: `1px solid ${t.active ? palette.cyan : palette.border}`,
            borderRadius: 999,
            color: t.active ? palette.cyan : palette.textDim,
            textDecoration: "none",
            background: t.active ? `${palette.cyan}15` : "transparent",
            letterSpacing: 0.3,
          }}
        >
          {t.label}
        </a>
      ))}
      <a
        href="/share?save_view=1"
        title="Save the current filters as a named view (coming soon)"
        style={{
          fontSize: 11,
          padding: "4px 10px",
          border: `1px dashed ${palette.border}`,
          borderRadius: 999,
          color: palette.textMute,
          textDecoration: "none",
        }}
      >
        + save current
      </a>
    </div>
  );
}
