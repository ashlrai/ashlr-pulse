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
import { createInvite, listInvitesByOwner, deletePendingInvite } from "@/lib/invite-db";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { CopyButton } from "@/components/ui/CopyButton";
import { palette, radius, space } from "@/lib/theme";

const DEFAULT_FIELDS = ["ts", "source", "model", "tokens_input", "tokens_output", "repo_name"];

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

  const input: CreatePeerShareInput = {
    owner_id: me.id,
    viewer_id: viewer.id,
    scope_type: scope_type as CreatePeerShareInput["scope_type"],
    scope_value: scope_type === "all" ? null : (scope_value_raw || null),
    granularity: granularity as CreatePeerShareInput["granularity"],
    fields: guard.fields,
  };

  try {
    await createPeerShare(input);
  } catch (err) {
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

async function deleteInviteAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return;
  await deletePendingInvite(token, me.id);
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

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; invite?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const [owned, granted, invites] = await Promise.all([
    listGrantsOwnedBy(me.id),
    listGrantsForViewer(me.id),
    listInvitesByOwner(me.id),
  ]);
  const { ok, error, invite: justCreatedToken } = await searchParams;
  const justCreated = justCreatedToken ? invites.find((i) => i.token === justCreatedToken) : undefined;
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const outstanding = invites.filter((i) => !i.accepted_at && new Date(i.expires_at).getTime() > Date.now());
  const accepted = invites.filter((i) => i.accepted_at).slice(0, 10);

  return (
    <DashboardShell maxWidth={1000}>
      <Header me={me} active="share" />
      <h1 style={pageTitle}>sharing</h1>
      <p style={pageSub}>
        configurable, revocable peer-visibility — granted per repo glob, granularity, and column whitelist.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {ok && <Banner variant="success">grant created.</Banner>}
        {error && <Banner variant="danger">{error.replace(/\+/g, " ")}</Banner>}

        {justCreated && (
          <Banner variant="success" title="invite created">
            <div style={{ marginBottom: 8 }}>
              Send this URL to your cofounder. Single-use, expires in 7 days. They sign in with GitHub on their own device.
            </div>
            <div style={{ display: "flex", alignItems: "stretch", gap: space.x2 }}>
              <code style={{ ...inviteUrlBox, flex: 1 }}>
                {origin}/accept-invite/{justCreated.token}
              </code>
              <CopyButton value={`${origin}/accept-invite/${justCreated.token}`} label="copy link" />
            </div>
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
            <CardHeader title={`outstanding invites · ${outstanding.length}`} hint="not accepted yet" />
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {outstanding.map((i) => {
                const url = `${origin}/accept-invite/${i.token}`;
                return (
                  <li
                    key={i.token}
                    style={{
                      padding: `${space.x2}px 0`,
                      borderBottom: `1px dashed ${palette.border}`,
                      fontSize: 11,
                      color: palette.textDim,
                      display: "flex",
                      alignItems: "center",
                      gap: space.x2,
                    }}
                  >
                    <code style={{ color: palette.green, wordBreak: "break-all", flex: 1 }}>
                      {url}
                    </code>
                    <CopyButton value={url} />
                    <form action={deleteInviteAction}>
                      <input type="hidden" name="token" value={i.token} />
                      <Button type="submit" variant="danger" size="sm">delete</Button>
                    </form>
                    <div style={{ width: "100%", flexBasis: "100%", color: palette.textMute, fontSize: 11, marginTop: 4 }}>
                      {i.label && <span>label: {i.label} · </span>}
                      <span>expires {new Date(i.expires_at).toISOString().slice(0, 10)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {accepted.length > 0 && (
          <Card>
            <CardHeader title={`accepted invites · ${accepted.length}`} hint="latest 10" />
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {accepted.map((i) => (
                <li
                  key={i.token}
                  style={{
                    padding: `${space.x2}px 0`,
                    borderBottom: `1px dashed ${palette.border}`,
                    fontSize: 11,
                    color: palette.textDim,
                  }}
                >
                  <span style={{ color: palette.text }}>{i.label ?? "(no label)"}</span>
                  <span style={{ color: palette.textMute }}>
                    {" · accepted "}{i.accepted_at ? new Date(i.accepted_at).toISOString().slice(0, 10) : ""}
                  </span>
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
