/**
 * /share — peer-share grants UI.
 *
 * One column for grants you own (and can revoke), one for grants you've
 * been granted (and can use as ?as=<owner_id> on the dashboard).
 *
 * Form actions hit the JSON API rather than calling the DB directly so
 * the API path stays the single source of truth for validation.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import {
  listGrantsOwnedBy,
  listGrantsForViewer,
  revokeShare,
  createPeerShare,
  findUserByEmail,
  type PeerShareRow,
  type CreatePeerShareInput,
} from "@/lib/peer-share-db";
import { validateFields, SHAREABLE_FIELDS } from "@/lib/peer-share-guard";
import { createInvite, listInvitesByOwner } from "@/lib/invite-db";
import { primaryOrgForUser } from "@/lib/org-db";
import { limitsFor, PlanGateError } from "@/lib/plan-gate";
import { readPeerShareSummaries, type PeerShareAggregateSummary } from "@/lib/peer-share-aggregate-refresh";
import { readHourlyRows, type PeerShareHourlyAggregate } from "@/lib/peer-share-hourly-aggregate";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { palette, radius, space } from "@/lib/theme";

export const dynamic = "force-dynamic";

const DEFAULT_FIELDS = [
  "ts",
  "source",
  "model",
  "duration_ms",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tool_calls_count",
  "tool_calls_types",
  "repo_name",
  "cost_millicents",
];

async function createShareAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const viewer_email = String(formData.get("viewer_email") ?? "").trim();
  const scope_type = String(formData.get("scope_type") ?? "all");
  const scope_value_raw = String(formData.get("scope_value") ?? "").trim();
  const granularity = String(formData.get("granularity") ?? "weekly");
  const fields = formData.getAll("fields").map(String);

  const guard = validateFields(fields);
  if (!guard.ok) redirect(`/share?error=${encodeURIComponent(guard.error)}`);
  if (!guard.ok) return;

  const viewer = await findUserByEmail(viewer_email);
  if (!viewer) {
    redirect(
      `/share?error=${encodeURIComponent(`no user with email ${viewer_email} — they must sign in to Pulse first`)}`,
    );
  }
  if (!viewer) return;
  if (viewer.id === me.id) redirect("/share?error=cannot+share+with+yourself");

  // Gate 4: check peer_share_enabled on the owner's plan.
  const ownerOrg = await primaryOrgForUser(me.id);
  if (ownerOrg) {
    const limits = limitsFor(ownerOrg);
    if (!limits.peer_share_enabled) {
      redirect("/share?error=upgrade-to-share");
    }
  }

  const input: CreatePeerShareInput = {
    owner_id: me.id,
    viewer_id: viewer.id,
    scope_type: scope_type as CreatePeerShareInput["scope_type"],
    scope_value: scope_type === "all" ? null : (scope_value_raw || null),
    granularity: granularity as CreatePeerShareInput["granularity"],
    fields: guard.fields,
    ownerOrg: ownerOrg ?? undefined,
  };

  try {
    await createPeerShare(input);
  } catch (err) {
    if (err instanceof PlanGateError) {
      redirect("/share?error=upgrade-to-share");
    }
    const m = err instanceof Error ? err.message : String(err);
    redirect(`/share?error=${encodeURIComponent(m)}`);
  }
  revalidatePath("/share");
  redirect("/share?ok=1");
}

async function revokeShareAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await revokeShare(id, me.id);
  revalidatePath("/share");
}

async function createInviteAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");

  const label = String(formData.get("label") ?? "").trim() || null;
  const scopeType = String(formData.get("invite_scope_type") ?? "") || null;
  const scopeValue = String(formData.get("invite_scope_value") ?? "").trim() || null;
  const granularity = String(formData.get("invite_granularity") ?? "") || null;
  const fields = formData.getAll("invite_fields").map(String);

  let suggestedFields: string[] | null = null;
  if (fields.length > 0) {
    const guard = validateFields(fields);
    if (!guard.ok) redirect(`/share?error=${encodeURIComponent(guard.error)}`);
    if (!guard.ok) return;
    suggestedFields = guard.fields;
  }

  const invite = await createInvite({
    owner_id: me.id,
    label,
    suggested_scope_type: scopeType as "all" | "project" | "repo_pattern" | null,
    suggested_scope_value: scopeType === "all" ? null : scopeValue,
    suggested_granularity: granularity as "realtime" | "daily" | "weekly" | "monthly" | null,
    suggested_fields: suggestedFields,
  });
  revalidatePath("/share");
  redirect(`/share?invite=${invite.token}`);
}

/** Clamp a date string to YYYY-MM-DD; returns fallback on invalid input. */
function clampDate(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(raw);
  return m ? raw : fallback;
}

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; invite?: string; from?: string; to?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  // Date-range defaults: last 30 days up to yesterday.
  const todayStr = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

  const { ok, error, invite: justCreatedToken, from: fromRaw, to: toRaw } = await searchParams;
  const dateFrom = clampDate(fromRaw, thirtyDaysAgoStr);
  const dateTo   = clampDate(toRaw,   todayStr);

  // Load hourly activity feed: last 6 hours of incoming peer activity for
  // all grants where me is the viewer (SSE polling fallback — server-rendered
  // snapshot; the client refreshes via /api/peer-share/subscribe SSE).
  const nowMs = Date.now();
  const sixHoursAgo = new Date(nowMs - 6 * 3_600_000);
  const nowDate = new Date(nowMs);

  const [owned, granted, invites, peerSummaries] = await Promise.all([
    listGrantsOwnedBy(me.id),
    listGrantsForViewer(me.id),
    listInvitesByOwner(me.id),
    readPeerShareSummaries(me.id).catch(() => [] as PeerShareAggregateSummary[]),
  ]);

  // For each grant where me is the viewer, fetch recent hourly rows.
  const activityFeedRows: (PeerShareHourlyAggregate & { ownerEmail: string })[] = [];
  for (const g of granted) {
    try {
      const rows = await readHourlyRows(g.owner_id, me.id, sixHoursAgo, nowDate);
      const nonZero = rows.filter((r) => r.costMillicents > 0 || r.eventCount > 0);
      for (const r of nonZero) {
        activityFeedRows.push({ ...r, ownerEmail: g.owner_email });
      }
    } catch {
      // Best-effort — skip failed owners.
    }
  }
  // Sort by bucket DESC so newest appears first.
  activityFeedRows.sort((a, b) => b.hourBucket.localeCompare(a.hourBucket));
  const justCreated = justCreatedToken ? invites.find((i) => i.token === justCreatedToken) : undefined;
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const outstanding = invites.filter((i) => !i.accepted_at && new Date(i.expires_at).getTime() > Date.now());

  return (
    <DashboardShell maxWidth={1000}>
      <Header me={me} active="share" />
      <h1 style={pageTitle}>sharing</h1>
      <p style={pageSub}>
        configurable, revocable peer-visibility — granted per repo glob, granularity, and column whitelist.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {ok && <Banner variant="success">grant created.</Banner>}
        {error === "upgrade-to-share" ? (
          <Banner variant="warning">
            Peer sharing is a Pro feature.{" "}
            <a href="/billing" style={{ color: palette.amber }}>Upgrade to Pro</a> to share your activity with teammates.
          </Banner>
        ) : (
          error && <Banner variant="danger">{error.replace(/\+/g, " ")}</Banner>
        )}

        {justCreated && (
          <Banner variant="success" title="invite created">
            <div style={{ marginBottom: 8 }}>
              Send this URL to your cofounder. Single-use, expires in 7 days. They sign in with GitHub on their own device.
            </div>
            <code style={inviteUrlBox}>{origin}/accept-invite/{justCreated.token}</code>
            {justCreated.label && (
              <div style={{ marginTop: 6, color: palette.textDim, fontSize: 11 }}>
                label: {justCreated.label}
              </div>
            )}
          </Banner>
        )}

        <form action={createInviteAction}>
          <Card>
            <CardHeader title="invite a cofounder" hint="generates a one-shot link · expires in 7 days" />
            <Field label="label (optional)">
              <Input name="label" type="text" placeholder="for kara" maxLength={120} />
            </Field>
            <div style={{ display: "flex", gap: space.x3 }}>
              <div style={{ flex: 1 }}>
                <Field label="suggested scope">
                  <Select name="invite_scope_type" defaultValue="repo_pattern">
                    <option value="all">all repos</option>
                    <option value="repo_pattern">repo glob (e.g. client-*)</option>
                    <option value="project">project id</option>
                  </Select>
                </Field>
              </div>
              <div style={{ flex: 2 }}>
                <Field label="scope value">
                  <Input name="invite_scope_value" placeholder="ashlr-*" />
                </Field>
              </div>
            </div>
            <Field label="suggested granularity">
              <Select name="invite_granularity" defaultValue="daily">
                <option value="realtime">realtime</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </Select>
            </Field>
            <FieldsetCheckboxes name="invite_fields" label="suggested fields" />
            <Button type="submit" variant="primary" style={{ marginTop: space.x3 }}>generate invite link</Button>
          </Card>
        </form>

        {outstanding.length > 0 && (
          <Card>
            <CardHeader title={`outstanding invites · ${outstanding.length}`} />
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {outstanding.map((i) => (
                <li
                  key={i.token}
                  style={{
                    padding: "6px 0", borderBottom: `1px dashed ${palette.border}`,
                    fontSize: 11, color: palette.textDim,
                  }}
                >
                  <code style={{ color: palette.green, wordBreak: "break-all" }}>
                    {origin}/accept-invite/{i.token}
                  </code>
                  {i.label && <span> · {i.label}</span>}
                  <span style={{ color: palette.textMute }}> · expires {new Date(i.expires_at).toISOString().slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <form action={createShareAction}>
          <Card>
            <CardHeader
              title="new grant"
              hint="grant a peer who has already signed in to Pulse"
            />
            <Field label="viewer email">
              <Input name="viewer_email" type="email" required />
            </Field>
            <div style={{ display: "flex", gap: space.x3 }}>
              <div style={{ flex: 1 }}>
                <Field label="scope">
                  <Select name="scope_type" defaultValue="all">
                    <option value="all">all repos</option>
                    <option value="repo_pattern">repo glob (e.g. client-*)</option>
                    <option value="project">project id</option>
                  </Select>
                </Field>
              </div>
              <div style={{ flex: 2 }}>
                <Field label="scope value (blank for all)">
                  <Input name="scope_value" placeholder="client-*" />
                </Field>
              </div>
            </div>
            <Field label="granularity">
              <Select name="granularity" defaultValue="weekly">
                <option value="realtime">realtime</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </Select>
            </Field>
            <FieldsetCheckboxes
              name="fields"
              label="fields (whitelist)"
              footnote="prompts, completions, and raw spans are never shareable — not on this list, not on any list."
            />
            <Button type="submit" variant="primary" style={{ marginTop: space.x3 }}>create grant</Button>
          </Card>
        </form>

        <Card>
          <CardHeader title={`grants you've issued · ${owned.length}`} />
          <GrantTable rows={owned} side="owned" />
        </Card>

        {/* Peer-share cost breakdown — loaded from materialized aggregate table */}
        {peerSummaries.length > 0 && (
          <Card>
            <CardHeader
              title="peer-share activity summary"
              hint="pre-computed nightly · last 30 days"
            />
            {/* Date-range picker — submits via GET so it's bookmarkable */}
            <form
              method="GET"
              action="/share"
              style={{ display: "flex", gap: space.x3, alignItems: "flex-end", marginBottom: space.x4 }}
            >
              <div>
                <label style={dateLabel}>from</label>
                <Input
                  name="from"
                  type="date"
                  defaultValue={dateFrom}
                  max={dateTo}
                  style={{ width: 140 }}
                />
              </div>
              <div>
                <label style={dateLabel}>to</label>
                <Input
                  name="to"
                  type="date"
                  defaultValue={dateTo}
                  min={dateFrom}
                  max={todayStr}
                  style={{ width: 140 }}
                />
              </div>
              <Button type="submit" variant="primary" size="sm">apply</Button>
            </form>
            <PeerShareSummaryTable rows={peerSummaries} />
          </Card>
        )}

        {/* Activity Feed — incoming peer activity for last 6 h */}
        {activityFeedRows.length > 0 && (
          <Card>
            <CardHeader
              title="incoming peer activity"
              hint="last 6 h · hourly buckets · refreshes on page load (SSE when realtime grant active)"
            />
            <ActivityFeed rows={activityFeedRows} />
          </Card>
        )}

        <Card>
          <CardHeader title={`grants you've been given · ${granted.length}`} />
          <GrantTable rows={granted} side="granted" />
        </Card>
      </div>
    </DashboardShell>
  );
}

function FieldsetCheckboxes({
  name, label, footnote,
}: { name: string; label: string; footnote?: string }): ReactElement {
  return (
    <fieldset
      style={{
        border: `1px solid ${palette.border}`,
        background: palette.bgRaised,
        padding: space.x3,
        borderRadius: radius.md,
        marginBottom: space.x4,
      }}
    >
      <legend
        style={{
          padding: "0 6px", fontSize: 11, color: palette.textDim,
          textTransform: "uppercase", letterSpacing: "0.8px", fontWeight: 500,
        }}
      >
        {label}
      </legend>
      {footnote && (
        <p style={{ margin: 0, color: palette.textMute, fontSize: 11, lineHeight: 1.5 }}>
          {footnote}
        </p>
      )}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: footnote ? 8 : 0,
      }}>
        {[...SHAREABLE_FIELDS].sort().map((f) => (
          <label key={f} style={{ fontSize: 12, color: palette.text, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              name={name}
              value={f}
              defaultChecked={DEFAULT_FIELDS.includes(f)}
              style={{ accentColor: palette.green }}
            />
            <code style={{ color: palette.cyan, fontSize: 11 }}>{f}</code>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function GrantTable({ rows, side }: { rows: PeerShareRow[]; side: "owned" | "granted" }): ReactElement {
  if (rows.length === 0) {
    return <p style={{ color: palette.textMute, fontSize: 12, margin: 0 }}>none yet.</p>;
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
          <th style={th}>{side === "owned" ? "viewer" : "owner"}</th>
          <th style={th}>scope</th>
          <th style={th}>granularity</th>
          <th style={th}>fields</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={td}>{side === "owned" ? r.viewer_email : r.owner_email}</td>
            <td style={td}>
              <code style={{ color: palette.cyan }}>
                {r.scope_type === "all" ? "all" : `${r.scope_type}: ${r.scope_value}`}
              </code>
            </td>
            <td style={td}>
              <span style={{ color: palette.amber }}>{r.granularity}</span>
            </td>
            <td style={{ ...td, color: palette.textDim, fontSize: 11 }}>{r.fields.join(", ")}</td>
            <td style={{ ...td, textAlign: "right" }}>
              {side === "owned" ? (
                <form action={revokeShareAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <Button type="submit" variant="danger" size="sm">revoke</Button>
                </form>
              ) : (
                <a
                  href={`/app?as=${r.owner_id}`}
                  style={{ fontSize: 11, color: palette.green, textDecoration: "none" }}
                >
                  view as them →
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PeerShareSummaryTable({ rows }: { rows: PeerShareAggregateSummary[] }): ReactElement {
  if (rows.length === 0) {
    return (
      <p style={{ color: palette.textMute, fontSize: 12, margin: 0 }}>
        no aggregate data yet — the nightly cron hasn&apos;t run.
      </p>
    );
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
          <th style={th}>viewer</th>
          <th style={th}>events</th>
          <th style={th}>cost (millicents)</th>
          <th style={th}>date range</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.viewerId} style={{ borderBottom: `1px dashed ${palette.border}` }}>
            <td style={td}>{r.viewerEmail}</td>
            <td style={{ ...td, color: palette.amber }}>{r.totalEvents.toLocaleString()}</td>
            <td style={{ ...td, color: palette.green }}>
              {r.totalCostMillicents.toLocaleString()}
              <span style={{ color: palette.textMute, fontSize: 10 }}> mc</span>
            </td>
            <td style={{ ...td, color: palette.textDim, fontSize: 11 }}>
              {r.dateFrom} → {r.dateTo}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActivityFeed({
  rows,
}: {
  rows: (PeerShareHourlyAggregate & { ownerEmail: string })[];
}): ReactElement {
  if (rows.length === 0) {
    return (
      <p style={{ color: palette.textMute, fontSize: 12, margin: 0 }}>
        no peer activity in the last 6 hours.
      </p>
    );
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
          <th style={th}>peer</th>
          <th style={th}>hour (UTC)</th>
          <th style={th}>source</th>
          <th style={th}>events</th>
          <th style={th}>tokens in</th>
          <th style={th}>tokens out</th>
          <th style={th}>cost (mc)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={`${r.ownerId}-${r.hourBucket}-${r.source}-${r.model}-${i}`}
            style={{ borderBottom: `1px dashed ${palette.border}` }}
          >
            <td style={td}>{r.ownerEmail}</td>
            <td style={{ ...td, color: palette.textDim, fontSize: 11 }}>
              {r.hourBucket.slice(0, 16).replace("T", " ")}
            </td>
            <td style={td}>
              <code style={{ color: palette.cyan, fontSize: 11 }}>{r.source || "—"}</code>
            </td>
            <td style={{ ...td, color: palette.amber }}>{r.eventCount.toLocaleString()}</td>
            <td style={{ ...td, color: palette.textDim }}>{r.tokensInput.toLocaleString()}</td>
            <td style={{ ...td, color: palette.textDim }}>{r.tokensOutput.toLocaleString()}</td>
            <td style={{ ...td, color: palette.green }}>
              {r.costMillicents.toLocaleString()}
              <span style={{ color: palette.textMute, fontSize: 10 }}> mc</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const pageTitle: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, margin: `${space.x2}px 0 ${space.x05}px`,
  color: palette.text, letterSpacing: "-0.5px",
};
const pageSub: React.CSSProperties = {
  color: palette.textDim, fontSize: 13, marginBottom: space.x5,
};
const inviteUrlBox: React.CSSProperties = {
  display: "block",
  padding: "10px 12px",
  background: palette.bgRaised,
  border: `1px solid ${palette.border}`,
  borderRadius: radius.sm,
  fontFamily: "var(--font-mono), monospace",
  fontSize: 11,
  wordBreak: "break-all",
  color: palette.green,
};
const th: React.CSSProperties = {
  padding: "8px 6px", color: palette.textDim,
  fontSize: 11, fontWeight: 500, letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const td: React.CSSProperties = { padding: "8px 6px", color: palette.text };
const dateLabel: React.CSSProperties = {
  display: "block", fontSize: 11, color: palette.textDim,
  textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4,
};
