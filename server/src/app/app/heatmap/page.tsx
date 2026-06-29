/**
 * /app/heatmap — Realtime peer-share telemetry heatmap page.
 *
 * Standalone page (not a tab in the main dashboard shell) that renders
 * the HeatmapTab component. Auth-gated — redirects to /login if no session.
 *
 * URL params (all optional, passed to HeatmapTab as initialFilters):
 *   ?hm_model=<model>   — initial model filter
 *   ?hm_repo=<repo>     — initial repo filter
 *   ?hm_status=<status> — initial peer status filter
 *   ?hm_win=<days>      — initial window in days
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";

import { currentUser } from "@/lib/current-user";
import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { getAgentStatus } from "@/lib/heartbeat";
import { HeatmapTab } from "../_tabs/heatmap";

export const dynamic = "force-dynamic";

interface SearchParams {
  hm_model?: string;
  hm_repo?: string;
  hm_status?: string;
  hm_win?: string;
}

export default async function HeatmapPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const { hm_model, hm_repo, hm_status, hm_win } = await searchParams;

  const nowUtc = new Date();
  const agentStatus = await getAgentStatus(me.id, nowUtc).catch(() => null);
  const agentSeenSecs = agentStatus?.seconds_ago ?? null;
  const agentAlive = agentSeenSecs != null && agentSeenSecs < 5 * 60;

  // Build initial filters from URL params (validation happens client-side).
  const initialFilters: Record<string, string | number> = {};
  if (hm_model) initialFilters.model = hm_model;
  if (hm_repo)  initialFilters.repo  = hm_repo;
  if (hm_status && ["active_grants", "active_work", "all"].includes(hm_status)) {
    initialFilters.status = hm_status;
  }
  if (hm_win) {
    const days = parseInt(hm_win, 10);
    if (Number.isFinite(days) && days >= 1 && days <= 30) {
      initialFilters.windowDays = days;
    }
  }

  return (
    <DashboardShell>
      <Header
        me={me}
        active="dashboard"
        agentAlive={agentAlive}
        agentSeenSecondsAgo={agentSeenSecs}
      />

      {/* Back link */}
      <div style={{ marginBottom: 16 }}>
        <a
          href="/app?tab=team"
          style={{ fontSize: 12, color: "#888", textDecoration: "none", letterSpacing: "0.3px" }}
        >
          ← back to dashboard
        </a>
      </div>

      <HeatmapTab
        userId={me.id}
        initialFilters={initialFilters}
      />
    </DashboardShell>
  );
}
