/**
 * /fleet — the human Fleet inbox: see + manage the fleet_command queue, the
 * approval surface for cloud→local intents.
 *
 * The Map and Health Radar ENQUEUE intents ("assign this goal", "approve this
 * proposal"); the local ashlr-hub daemon PULLS and executes them. This page is
 * where an operator watches that queue drain — pending / claimed / done /
 * failed, with created time, kind, target, and the metadata-only result or
 * error — and cancels a still-pending command before the daemon claims it.
 *
 * Server component: resolves user + org, enforces the Pro/Team gate, loads the
 * first page of commands + status counts, and hands them to the self-refreshing
 * client inbox. Metadata only — no code/prompts/diffs cross here.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { listForOrg, countsByStatus } from "@/lib/fleet-inbox-db";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Banner } from "@/components/ui/Banner";
import { FleetInbox } from "@/components/fleet/FleetInbox";
import { HealthRollup } from "@/components/fleet/HealthRollup";
import { palette, space } from "@/lib/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function FleetPage(): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  const mapEnabled = org ? limitsFor(org).map_enabled : false;

  // Free tier (or no org): render the page chrome + an upgrade teaser, no data.
  if (!org || !mapEnabled) {
    return (
      <DashboardShell>
        <Header me={me} active="fleet" />
        <PageHead />
        <div style={{ marginTop: space.x4 }}>
          <Banner variant="info">
            The Fleet inbox is a Pro feature. Upgrade at{" "}
            <a href="/billing" style={{ color: palette.magenta }}>/billing</a>{" "}
            to assign work to your local fleet and watch it drain here.
          </Banner>
        </div>
      </DashboardShell>
    );
  }

  const [commands, counts] = await Promise.all([
    listForOrg(org.id),
    countsByStatus(org.id),
  ]);

  const fleetHealthEnabled = process.env.PULSE_FLEET_HEALTH === "true";

  return (
    <DashboardShell>
      <Header me={me} active="fleet" />
      <PageHead pending={counts.pending} />
      {fleetHealthEnabled && (
        <div style={{ marginTop: space.x4 }}>
          <HealthRollup enabled={fleetHealthEnabled} />
        </div>
      )}
      <div style={{ marginTop: space.x4 }}>
        <FleetInbox initialCommands={commands} initialCounts={counts} />
      </div>
    </DashboardShell>
  );
}

function PageHead({ pending }: { pending?: number }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: space.x3 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: palette.text }}>Fleet</h1>
        <p style={{ fontSize: 13, color: palette.textDim, margin: "4px 0 0" }}>
          Cloud→local commands the daemon pulls &amp; runs.
          {pending != null && pending > 0
            ? ` ${pending} pending — cancel any before it's claimed.`
            : " Assign work from the Map or Health Radar."}
        </p>
      </div>
    </div>
  );
}
