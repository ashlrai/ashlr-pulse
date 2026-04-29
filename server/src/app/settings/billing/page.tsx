/**
 * /settings/billing — org billing management.
 *
 * For admins: shows current plan, seat count, period end, trial status,
 * and a "manage billing" CTA that opens the Stripe Customer Portal.
 * For non-admins: read-only summary + "ask your owner".
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin, countMembers, countProjects } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import { isStripeConfigured } from "@/lib/stripe";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { CheckoutButton } from "@/components/ui/CheckoutButton";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams { ok?: string; error?: string }

export default async function BillingPage({
  searchParams,
}: { searchParams: Promise<SearchParams> }): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  if (!org) redirect("/app");

  const params = await searchParams;
  const [admin, members, projects] = await Promise.all([
    isOrgAdmin(org.id, me.id),
    countMembers(org.id),
    countProjects(org.id),
  ]);
  const limits = limitsFor(org);
  const stripeReady = isStripeConfigured();
  const onTrial = org.subscription_status === "trialing";
  const paid = org.plan !== "free";

  return (
    <DashboardShell maxWidth={760}>
      <Header me={me} active="settings" />
      <h1 style={pageTitle}>billing</h1>
      <p style={pageSub}>
        plan, seats, and invoices for <code style={{ color: palette.cyan }}>{org.name}</code>.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {params.ok && <Banner variant="success">subscription updated.</Banner>}
        {params.error && <Banner variant="danger">{params.error.replace(/\+/g, " ")}</Banner>}

        <Card>
          <CardHeader
            title={`current plan · ${org.plan}`}
            hint={
              org.subscription_status
                ? `status: ${org.subscription_status}${onTrial && org.trial_ends_at ? ` (until ${org.trial_ends_at.slice(0, 10)})` : ""}`
                : "free tier"
            }
          />
          <Row label="members"   value={`${members} / ${fmtLimit(limits.max_members)}`}   warn={members > limits.max_members} />
          <Row label="projects"  value={`${projects} / ${fmtLimit(limits.max_projects)}`} warn={projects > limits.max_projects} />
          <Row label="retention" value={`${limits.retention_days} days`} />
          <Row label="ai features" value={limits.ai_features ? "enabled" : "Pro only"} />
          <Row label="peer-share"  value={limits.peer_share_enabled ? "enabled" : "Pro only"} />
          {paid && org.current_period_end && (
            <Row
              label={onTrial ? "trial ends" : "next renews"}
              value={org.current_period_end.slice(0, 10)}
            />
          )}
          {paid && (
            <Row label="seats billed" value={String(org.plan_seats)} />
          )}

          <div style={{ marginTop: space.x4, display: "flex", gap: space.x3, alignItems: "center" }}>
            {!stripeReady ? (
              <Banner variant="warning">billing is not configured on this server.</Banner>
            ) : !admin ? (
              <span style={{ color: palette.textMute, fontSize: 12 }}>
                only the org owner can change the plan.
              </span>
            ) : !paid ? (
              <CheckoutButton mode="checkout" plan="pro">
                upgrade to Pro · $10/dev/mo
              </CheckoutButton>
            ) : (
              <CheckoutButton mode="portal" variant="secondary">manage billing →</CheckoutButton>
            )}
          </div>
        </Card>

        {!paid && (
          <Card>
            <CardHeader title="what Pro unlocks" />
            <ul style={{ margin: 0, paddingLeft: space.x4, color: palette.text, fontSize: 13, lineHeight: 1.8 }}>
              <li>unlimited members + projects</li>
              <li>90-day retention (free is 7 days)</li>
              <li>peer-share grants for cofounder visibility</li>
              <li>AI briefing, anomaly explanations, weekly recap</li>
              <li>predictive trends + cohort comparison</li>
            </ul>
            <p style={{ margin: `${space.x3}px 0 0`, fontSize: 12, color: palette.textDim }}>
              compare plans on the <a href="/pricing" style={{ color: palette.cyan }}>pricing page</a>.
            </p>
          </Card>
        )}
      </div>
    </DashboardShell>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: `${space.x2}px 0`,
        borderTop: `1px dashed ${palette.border}`,
        fontSize: 13,
      }}
    >
      <span style={{ color: palette.textDim }}>{label}</span>
      <span style={{ color: warn ? palette.red : palette.text, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

function fmtLimit(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  return String(n);
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
