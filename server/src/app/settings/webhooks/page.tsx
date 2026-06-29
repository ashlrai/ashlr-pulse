/**
 * /settings/webhooks — fleet scorecard webhook sink configuration (Pro+).
 *
 * Allows org admins to configure:
 *   - Webhook URL (HTTPS endpoint — Slack, PagerDuty, email relay, etc.)
 *   - Signing secret (optional HMAC-SHA256 — receiver verifies x-pulse-signature)
 *   - Event subscriptions (which conditions trigger a delivery)
 *   - Test-fire (sends a synthetic payload immediately to verify the endpoint)
 *
 * Feature gate: Pro or Team plan only. Free users see an upgrade prompt.
 *
 * Privacy: this page configures the delivery target only — it never displays
 * payload content, org-level metrics, or any user-authored data.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { primaryOrgForUser, isOrgAdmin } from "@/lib/org-db";
import { limitsFor } from "@/lib/plan-gate";
import {
  getOrgWebhookConfig,
  setOrgWebhookConfig,
  WEBHOOK_EVENT_SLUGS,
  type WebhookEventSlug,
} from "@/lib/webhook-db";
import {
  buildMetricsSnapshot,
  evaluateWebhookEvents,
  deliverWebhook,
  type WebhookPayload,
} from "@/lib/fleet-scorecard-webhook";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { palette, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

interface SearchParams {
  ok?: string;
  error?: string;
  test_fired?: string;
  test_no_events?: string;
}

const EVENT_LABELS: Record<WebhookEventSlug, { label: string; hint: string }> = {
  fleet_quality_alert: {
    label: "Fleet quality alert",
    hint: "Fires when approval rate < 80% (with ≥3 resolved proposals).",
  },
  budget_exceeded: {
    label: "Budget exceeded",
    hint: "Fires when daily spend exceeds the org's configured budget cap.",
  },
  stale_review: {
    label: "Stale review backlog",
    hint: "Fires when ≥5 proposals are pending past the 3-day SLA.",
  },
  agent_down: {
    label: "Agent down",
    hint: "Fires when active agents drop to zero after recent activity.",
  },
};

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

async function saveWebhookConfigAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  if (!org) redirect(`/settings/webhooks?error=${encodeURIComponent("no org")}`);

  const limits = limitsFor(org);
  if (!limits.ai_features) {
    // ai_features is Pro+; free tier can't configure webhooks.
    redirect(`/settings/webhooks?error=${encodeURIComponent("Pro plan required for webhooks")}`);
  }
  if (!(await isOrgAdmin(org.id, me.id))) {
    redirect(`/settings/webhooks?error=${encodeURIComponent("admin required")}`);
  }

  const urlRaw = String(formData.get("webhook_url") ?? "").trim();
  const secretRaw = String(formData.get("webhook_secret") ?? "").trim();

  // Validate URL (empty = disable).
  if (urlRaw !== "") {
    try {
      const parsed = new URL(urlRaw);
      if (parsed.protocol !== "https:") {
        redirect(`/settings/webhooks?error=${encodeURIComponent("webhook URL must use HTTPS")}`);
      }
    } catch {
      redirect(`/settings/webhooks?error=${encodeURIComponent("invalid webhook URL")}`);
    }
  }

  // Collect subscribed events from checkboxes.
  const subscribedEvents: WebhookEventSlug[] = WEBHOOK_EVENT_SLUGS.filter(
    (slug) => formData.get(`event_${slug}`) === "on",
  );

  try {
    await setOrgWebhookConfig(org.id, {
      webhook_url: urlRaw === "" ? null : urlRaw,
      webhook_secret: secretRaw === "" ? null : secretRaw,
      webhook_events: subscribedEvents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/settings/webhooks?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/settings/webhooks");
  redirect("/settings/webhooks?ok=1");
}

async function testFireWebhookAction(): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const org = await primaryOrgForUser(me.id);
  if (!org) redirect(`/settings/webhooks?error=${encodeURIComponent("no org")}`);

  const limits = limitsFor(org);
  if (!limits.ai_features) {
    redirect(`/settings/webhooks?error=${encodeURIComponent("Pro plan required")}`);
  }
  if (!(await isOrgAdmin(org.id, me.id))) {
    redirect(`/settings/webhooks?error=${encodeURIComponent("admin required")}`);
  }

  const config = await getOrgWebhookConfig(org.id);
  if (!config.webhook_url) {
    redirect(`/settings/webhooks?error=${encodeURIComponent("no webhook URL configured")}`);
  }

  // Build a synthetic test snapshot that fires all subscribed events.
  // The test snapshot intentionally breaches thresholds so the receiver
  // always gets a payload — it is clearly labeled as a test via event slug.
  const { computeFleetMetrics } = await import("@/lib/fleet-oversight");
  const metrics = await computeFleetMetrics(org.id, 1);
  const snapshot = buildMetricsSnapshot(metrics);

  const firedEvents = evaluateWebhookEvents(snapshot, config.webhook_events);

  if (firedEvents.length === 0) {
    // No events fire on real data — deliver a synthetic fleet_quality_alert
    // so the user can verify the endpoint is reachable.
    const testPayload: WebhookPayload = {
      event: "fleet_quality_alert",
      org_id: org.id,
      window: metrics.window,
      metrics_snapshot: snapshot,
      threshold: 0.8,
      actual: snapshot.approval_rate,
      triggered_at: new Date().toISOString(),
    };
    const result = await deliverWebhook(
      config.webhook_url,
      testPayload,
      config.webhook_secret,
    );
    if (!result.ok) {
      redirect(
        `/settings/webhooks?error=${encodeURIComponent(`delivery failed (${result.status ?? "network error"})`)}`
      );
    }
    redirect("/settings/webhooks?test_no_events=1");
  }

  // Fire all currently-triggered events.
  for (const { event, threshold, actual } of firedEvents) {
    const payload: WebhookPayload = {
      event,
      org_id: org.id,
      window: metrics.window,
      metrics_snapshot: snapshot,
      threshold,
      actual,
      triggered_at: new Date().toISOString(),
    };
    const result = await deliverWebhook(
      config.webhook_url,
      payload,
      config.webhook_secret,
    );
    if (!result.ok) {
      redirect(
        `/settings/webhooks?error=${encodeURIComponent(`delivery failed (${result.status ?? "network error"})`)}`
      );
    }
  }

  redirect("/settings/webhooks?test_fired=1");
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function WebhooksSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const params = await searchParams;
  const [org] = await Promise.all([primaryOrgForUser(me.id)]);

  const limits = org ? limitsFor(org) : null;
  const isPro = limits?.ai_features ?? false;
  const isAdmin = org ? await isOrgAdmin(org.id, me.id) : false;
  const config = org && isPro ? await getOrgWebhookConfig(org.id) : null;

  return (
    <DashboardShell maxWidth={760}>
      <Header me={me} active="settings" />
      <h1 style={pageTitle}>Webhook Settings</h1>
      <div style={pageSub}>
        Receive signed fleet health alerts at any HTTPS endpoint — Slack, PagerDuty, email relay, or your own service.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {params.ok && <Banner variant="success">Webhook configuration saved.</Banner>}
        {params.test_fired && (
          <Banner variant="success">Test payload delivered — check your endpoint.</Banner>
        )}
        {params.test_no_events && (
          <Banner variant="success">
            No events currently firing on real data — sent a synthetic fleet_quality_alert
            so you can verify the endpoint is reachable.
          </Banner>
        )}
        {params.error && <Banner variant="danger">{params.error}</Banner>}

        {!isPro && (
          <Card>
            <CardHeader title="pro plan required" />
            <p style={{ color: palette.textDim, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
              Webhook delivery is available on Pro and Team plans. Upgrade to configure
              external alerting for your fleet.
            </p>
            <div style={{ marginTop: space.x3 }}>
              <a href="/billing" style={{ textDecoration: "none" }}>
                <Button variant="primary">Upgrade to Pro</Button>
              </a>
            </div>
          </Card>
        )}

        {isPro && (
          <form action={saveWebhookConfigAction}>
            <Card>
              <CardHeader
                title="webhook endpoint"
                hint="HTTPS URL that receives the signed daily scorecard POST"
              />

              <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.6, margin: `0 0 ${space.x3}px` }}>
                Pulse POSTs a JSON payload to this URL when any subscribed event fires.
                The payload contains only fleet metadata (counts, rates, costs) — never
                prompts, code, or diffs. When a signing secret is set, each request carries
                an <code style={code}>x-pulse-signature: sha256=&lt;hex&gt;</code> header
                you can verify with HMAC-SHA256.
              </p>

              <Field label="Webhook URL (HTTPS)">
                <Input
                  type="url"
                  name="webhook_url"
                  defaultValue={config?.webhook_url ?? ""}
                  placeholder="https://hooks.slack.com/services/…"
                  disabled={!isAdmin}
                />
              </Field>

              <Field
                label="Signing secret (optional)"
                hint="Store a random 32+ char secret here and verify x-pulse-signature on your end"
              >
                <Input
                  type="password"
                  name="webhook_secret"
                  defaultValue={config?.webhook_secret ?? ""}
                  placeholder="leave blank to skip HMAC signing"
                  disabled={!isAdmin}
                  autoComplete="new-password"
                />
              </Field>

              <Field label="Notify me when…">
                <div style={{ display: "flex", flexDirection: "column", gap: space.x2, marginTop: 4 }}>
                  {WEBHOOK_EVENT_SLUGS.map((slug) => {
                    const { label, hint } = EVENT_LABELS[slug];
                    const checked = config?.webhook_events.includes(slug) ?? false;
                    return (
                      <label
                        key={slug}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          cursor: isAdmin ? "pointer" : "default",
                          opacity: isAdmin ? 1 : 0.6,
                        }}
                      >
                        <input
                          type="checkbox"
                          name={`event_${slug}`}
                          defaultChecked={checked}
                          disabled={!isAdmin}
                          style={{ accentColor: palette.green, marginTop: 2, flexShrink: 0 }}
                        />
                        <span>
                          <span style={{ color: palette.text, fontSize: 13 }}>{label}</span>
                          <span style={{ color: palette.textMute, fontSize: 11, display: "block" }}>
                            {hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </Field>

              {!isAdmin && (
                <p style={{ color: palette.textMute, fontSize: 11, margin: `${space.x2}px 0 0` }}>
                  Only org admins can change webhook settings.
                </p>
              )}

              {isAdmin && (
                <div style={{ display: "flex", gap: space.x3, alignItems: "center", marginTop: space.x4 }}>
                  <Button type="submit" variant="primary">Save webhook</Button>
                </div>
              )}
            </Card>
          </form>
        )}

        {isPro && config?.webhook_url && (
          <form action={testFireWebhookAction}>
            <Card>
              <CardHeader title="test-fire" hint="send a payload now to verify the endpoint" />
              <p style={{ color: palette.textDim, fontSize: 12, lineHeight: 1.6, margin: `0 0 ${space.x3}px` }}>
                Evaluates yesterday&apos;s metrics against your subscribed events and delivers
                the payload immediately. If no events are currently firing on real data, a
                synthetic <code style={code}>fleet_quality_alert</code> is sent so you can
                confirm the endpoint is reachable. Does not affect tomorrow&apos;s scheduled run.
              </p>
              <Button type="submit" variant="secondary" disabled={!isAdmin}>
                Send test payload
              </Button>
            </Card>
          </form>
        )}

        <Card>
          <CardHeader title="payload format" hint="metadata-only — never prompts, code, or diffs" />
          <pre style={payloadPre}>{JSON.stringify(
            {
              event: "fleet_quality_alert",
              org_id: "<uuid>",
              window: { start: "2026-06-28T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z", days: 1 },
              metrics_snapshot: {
                proposals: 12, applied: 7, rejected: 5, pending: 0,
                approval_rate: 0.58, rejection_rate: 0.42,
                cost_usd: 3.21, active_agents: 2, repos_touched: 4,
                stale_review_count: 0, failed_commands: 0,
                spend_usd: 3.21, budget_cap_usd: 50, over_budget: false,
                trend: "flat",
              },
              threshold: 0.8,
              actual: 0.58,
              triggered_at: "2026-06-29T02:30:00.000Z",
            },
            null,
            2,
          )}</pre>
        </Card>
      </div>
    </DashboardShell>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const code: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 11,
  background: palette.bgRaised,
  padding: "1px 4px", borderRadius: 3,
  color: palette.text,
};
const payloadPre: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 11,
  background: palette.bgRaised,
  color: palette.textDim,
  borderRadius: 6, padding: `${space.x3}px`,
  overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
  margin: 0, marginTop: space.x2,
  maxHeight: 400,
};
