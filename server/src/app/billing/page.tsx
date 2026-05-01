/**
 * /billing — current plan, status, period dates, and upgrade/manage actions.
 *
 * Server component for the read side; UpgradeButton / PortalButton are
 * client components that POST to the billing API.
 *
 * Search params (set by Stripe redirect-back):
 *   ?session_id=cs_… — checkout finished. Stripe webhook will land within
 *                       seconds with the real subscription state. We render
 *                       a "thanks, syncing" banner.
 *   ?canceled=1     — user canceled checkout. Render a quiet info banner.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin } from "@/lib/org-db";
import { configuredPrices } from "@/lib/billing-config";
import { limitsFor } from "@/lib/plan-gate";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { palette, space } from "@/lib/theme";

import { UpgradeButton, PortalButton } from "./BillingActions";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ session_id?: string; canceled?: string }>;
}

export default async function BillingPage({ searchParams }: PageProps): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  if (!org) {
    return (
      <DashboardShell>
        <Header me={me} active="billing" />
        <Card>
          <CardHeader title="Billing" />
          <p style={{ color: palette.textDim }}>
            No organization yet. Create a project first — your org gets created automatically.
          </p>
        </Card>
      </DashboardShell>
    );
  }

  const admin = await isOrgAdmin(org.id, me.id);
  const limits = limitsFor(org);
  const sp = await searchParams;
  const prices = configuredPrices();
  const stripeWired = prices.length > 0;

  const banners: ReactElement[] = [];
  if (sp.session_id) {
    banners.push(
      <Banner key="ok" variant="success">
        Checkout complete. Your subscription is syncing — refresh in a few seconds.
      </Banner>,
    );
  }
  if (sp.canceled) {
    banners.push(
      <Banner key="cancel" variant="info">Checkout canceled. No charge made.</Banner>,
    );
  }

  return (
    <DashboardShell>
      <Header me={me} active="billing" />
      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {banners}

        <Card>
          <CardHeader title="Current plan" />
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: `${space.x2}px ${space.x4}px`, fontSize: 13 }}>
            <Label>Plan</Label>
            <Value>
              <PlanChip plan={org.plan} />
              {org.subscription_status && <StatusChip status={org.subscription_status} />}
            </Value>

            <Label>Org</Label>
            <Value>{org.name} <span style={{ color: palette.textMute }}>· {org.slug}</span></Value>

            <Label>Seats</Label>
            <Value>{org.plan_seats}</Value>

            <Label>Members allowed</Label>
            <Value>{Number.isFinite(limits.max_members) ? String(limits.max_members) : "unlimited"}</Value>

            <Label>Projects allowed</Label>
            <Value>{Number.isFinite(limits.max_projects) ? String(limits.max_projects) : "unlimited"}</Value>

            <Label>Retention</Label>
            <Value>{Number.isFinite(limits.retention_days) ? `${limits.retention_days} days` : "unlimited"}</Value>

            <Label>AI features</Label>
            <Value>{limits.ai_features ? "enabled" : "Pro/Team only"}</Value>

            {org.trial_ends_at && (
              <>
                <Label>Trial ends</Label>
                <Value>{fmtDate(org.trial_ends_at)}</Value>
              </>
            )}
            {org.current_period_end && (
              <>
                <Label>Current period ends</Label>
                <Value>{fmtDate(org.current_period_end)}</Value>
              </>
            )}
          </div>
        </Card>

        {!admin && (
          <Card>
            <p style={{ color: palette.textDim, fontSize: 13 }}>
              Only an org admin can change billing. Ask the owner to upgrade.
            </p>
          </Card>
        )}

        {admin && (
          <Card>
            <CardHeader title={org.plan === "free" ? "Upgrade" : "Change plan"} />
            {!stripeWired && (
              <Banner variant="warning">
                Stripe price IDs aren&apos;t configured yet. Set <code>STRIPE_PRICE_PRO_MONTHLY</code>
                {" "}(and friends) in Railway, then come back.
              </Banner>
            )}
            {stripeWired && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: space.x3 }}>
                {prices.map(p => (
                  <UpgradeButton
                    key={`${p.plan}-${p.interval}`}
                    plan={p.plan}
                    interval={p.interval}
                    label={`${labelFor(p.plan)} · ${p.interval}`}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {admin && org.stripe_customer_id && (
          <Card>
            <CardHeader title="Manage subscription" />
            <p style={{ color: palette.textDim, fontSize: 13, marginBottom: space.x3 }}>
              Update payment method, view invoices, switch plans, or cancel — all in the
              Stripe-hosted portal.
            </p>
            <PortalButton />
          </Card>
        )}
      </div>
    </DashboardShell>
  );
}

function Label({ children }: { children: React.ReactNode }): ReactElement {
  return <span style={{ color: palette.textMute, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px", alignSelf: "center" }}>{children}</span>;
}

function Value({ children }: { children: React.ReactNode }): ReactElement {
  return <span style={{ color: palette.text, display: "flex", alignItems: "center", gap: space.x2 }}>{children}</span>;
}

function PlanChip({ plan }: { plan: "free" | "pro" | "team" }): ReactElement {
  const color = plan === "free" ? palette.textDim : plan === "pro" ? palette.cyan : palette.magenta;
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, border: `1px solid ${color}`,
      color, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px",
    }}>{plan}</span>
  );
}

function StatusChip({ status }: { status: string }): ReactElement {
  const isOk = status === "active" || status === "trialing";
  const color = isOk ? "#5ee08a" : "#ff9b6b";
  return (
    <span style={{ color, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
      {status.replace("_", " ")}
    </span>
  );
}

function labelFor(plan: "pro" | "team"): string {
  return plan === "pro" ? "Pro" : "Team";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
