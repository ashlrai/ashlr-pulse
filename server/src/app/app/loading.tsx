/**
 * /app/loading.tsx — Next.js renders this while page.tsx is awaiting
 * its server-side data. Mirrors the dashboard's structure with
 * pulsing skeleton shapes so the perceived load is instant instead
 * of a blank page.
 */

import type { ReactElement } from "react";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { palette, space } from "@/lib/theme";

export default function Loading(): ReactElement {
  return (
    <DashboardShell>
      {/* Header placeholder. */}
      <div
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: `${space.x3}px 0`,
          borderBottom: `1px solid ${palette.border}`,
          marginBottom: space.x6,
        }}
      >
        <Skeleton width={140} height={22} />
        <Skeleton width={160} height={22} />
      </div>

      {/* Window chip placeholder. */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: space.x3 }}>
        <Skeleton width={180} height={28} rounded={6} />
      </div>

      {/* Stat strip — 4 cards. */}
      <div className="dash-stat-strip">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} pad="tight">
            <Skeleton width={80} height={11} />
            <div style={{ height: 8 }} />
            <Skeleton width={120} height={28} />
            <div style={{ height: 12 }} />
            <Skeleton height={36} />
          </Card>
        ))}
      </div>

      {/* Briefing skeleton. */}
      <div style={{ marginTop: space.x5 }}>
        <Card>
          <Skeleton width={220} height={11} />
          <div style={{ height: 10 }} />
          <Skeleton height={14} />
          <div style={{ height: 6 }} />
          <Skeleton height={14} width="80%" />
        </Card>
      </div>

      {/* Chart grid placeholders. */}
      <div className="dash-grid" style={{ marginTop: space.x6 }}>
        <div className="dash-grid-full">
          <Card>
            <Skeleton width={200} height={11} />
            <div style={{ height: 12 }} />
            <Skeleton height={260} />
          </Card>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <Skeleton width={140} height={11} />
            <div style={{ height: 12 }} />
            <Skeleton height={220} />
          </Card>
        ))}
        <div className="dash-grid-full">
          <Card>
            <Skeleton width={200} height={11} />
            <div style={{ height: 12 }} />
            <Skeleton height={180} />
          </Card>
        </div>
      </div>
    </DashboardShell>
  );
}
