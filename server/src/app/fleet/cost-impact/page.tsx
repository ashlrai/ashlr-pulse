/**
 * /fleet/cost-impact — Realtime fleet telemetry cost-impact dashboard.
 *
 * Server component: resolves user + org, enforces the Pro/Team gate,
 * loads the initial OrgCostImpact snapshot, and hands off to the
 * FleetCostRealtime client component which opens the SSE stream and
 * renders the stacked-bar chart, sparkline, and delta badges.
 *
 * All data is metadata-only — no prompts, completions, code, or diffs.
 * The SSE stream at /api/fleet/cost-impact/subscribe applies the same
 * peer-share scope filter as /api/dashboard/subscribe.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { loadOrgCostImpact } from "@/lib/fleet-cost-impact";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Banner } from "@/components/ui/Banner";
import { FleetCostRealtime } from "@/components/fleet-cost-realtime";
import { palette, space } from "@/lib/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function FleetCostImpactPage(): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const org        = await primaryOrgForUser(me.id);
  const mapEnabled = org ? limitsFor(org).map_enabled : false;

  if (!org || !mapEnabled) {
    return (
      <DashboardShell>
        <Header me={me} active="fleet" />
        <PageHead />
        <div style={{ marginTop: space.x4 }}>
          <Banner variant="info">
            The Fleet cost-impact dashboard is a Pro feature. Upgrade at{" "}
            <a href="/billing" style={{ color: palette.magenta }}>/billing</a>{" "}
            to see realtime cost attribution for your fleet.
          </Banner>
        </div>
      </DashboardShell>
    );
  }

  // Initial snapshot — client refreshes via SSE from this baseline.
  const initial = await loadOrgCostImpact(org.id, 7).catch(() => null);

  return (
    <DashboardShell>
      <Header me={me} active="fleet" />
      <PageHead />
      <div style={{ marginTop: space.x4 }}>
        <FleetCostRealtime
          userId={me.id}
          initialCostImpact={initial}
        />
      </div>
    </DashboardShell>
  );
}

function PageHead(): ReactElement {
  return (
    <div
      style={{
        display:        "flex",
        alignItems:     "baseline",
        justifyContent: "space-between",
        flexWrap:       "wrap",
        gap:            space.x3,
      }}
    >
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: palette.text }}>
          Fleet Cost Impact
        </h1>
        <p style={{ fontSize: 13, color: palette.textDim, margin: "4px 0 0" }}>
          Realtime 5-minute rolling cost windows — grouped by event type and outcome,
          with delta badges vs team baseline.
        </p>
      </div>
      <a
        href="/fleet"
        style={{ fontSize: 13, color: palette.cyan, textDecoration: "none" }}
      >
        ← Fleet inbox
      </a>
    </div>
  );
}
