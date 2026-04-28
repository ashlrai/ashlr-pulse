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
import { Header } from "@/components/Header";
import {
  listGrantsOwnedBy,
  listGrantsForViewer,
  revokeShare,
  type PeerShareRow,
} from "@/lib/peer-share-db";
import { validateFields, SHAREABLE_FIELDS } from "@/lib/peer-share-guard";
import { createInvite, listInvitesByOwner, type InviteRow } from "@/lib/invite-db";
import {
  createPeerShare,
  findUserByEmail,
  type CreatePeerShareInput,
} from "@/lib/peer-share-db";

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
  if (!guard.ok) {
    redirect(`/share?error=${encodeURIComponent(guard.error)}`);
  }
  if (!guard.ok) return; // narrowing for TS

  const viewer = await findUserByEmail(viewer_email);
  if (!viewer) {
    redirect(
      `/share?error=${encodeURIComponent(
        `no user with email ${viewer_email} — they must sign in to Pulse first`,
      )}`,
    );
  }
  if (!viewer) return;
  if (viewer.id === me.id) {
    redirect("/share?error=cannot+share+with+yourself");
  }

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
  // Redirect with the token so the page can render a copyable URL block.
  // The token in the URL is intentional: /share is auth'd, only the
  // owner sees their own invite tokens.
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

  return (
    <main style={{ padding: "0 32px 32px", maxWidth: 960, margin: "0 auto" }}>
      <Header me={me} active="share" />
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.5px" }}>sharing</h1>
      <p style={{ color: "#666", marginTop: 4, fontSize: 13 }}>
        configurable, revocable peer-visibility — granted per repo glob, granularity, and column whitelist.
      </p>

      {ok && <p style={{ color: "#080" }}>grant created.</p>}
      {error && <p style={{ color: "#c00" }}>error: {error}</p>}

      {justCreated && (
        <div style={inviteBanner}>
          <div style={{ fontSize: 12, color: "#666", textTransform: "uppercase", letterSpacing: "0.1em" }}>invite created</div>
          <div style={{ marginTop: 4, fontSize: 14 }}>
            Send this URL to your cofounder. Single-use, expires in 7 days. They sign in with GitHub at the link, peer-share is auto-suggested with the defaults you picked.
          </div>
          <code style={inviteUrlBox}>{origin}/accept-invite/{justCreated.token}</code>
          {justCreated.label && <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>label: {justCreated.label}</div>}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 32 }}>invite a cofounder</h2>
      <p style={{ color: "#666", fontSize: 12, marginTop: 4, marginBottom: 12 }}>
        Generates a one-shot link. The invitee signs in with GitHub on their own device — Pulse never holds their credentials.
      </p>
      <form action={createInviteAction} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
        <label>
          label (optional, helps you tell invites apart)
          <input name="label" type="text" placeholder="for kara" maxLength={120} style={inp} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>
            suggested scope
            <select name="invite_scope_type" defaultValue="repo_pattern" style={inp}>
              <option value="all">all repos</option>
              <option value="repo_pattern">repo glob (e.g. client-*)</option>
              <option value="project">project id</option>
            </select>
          </label>
          <label style={{ flex: 2 }}>
            scope value
            <input name="invite_scope_value" placeholder="ashlr-*" style={inp} />
          </label>
        </div>
        <label>
          suggested granularity
          <select name="invite_granularity" defaultValue="daily" style={inp}>
            <option value="realtime">realtime</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
          </select>
        </label>
        <fieldset style={{ border: "1px solid #ddd", padding: 12, borderRadius: 4 }}>
          <legend>suggested fields</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 4 }}>
            {[...SHAREABLE_FIELDS].sort().map((f) => (
              <label key={f} style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  name="invite_fields"
                  value={f}
                  defaultChecked={DEFAULT_FIELDS.includes(f)}
                />{" "}
                {f}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" style={btn}>generate invite link</button>
      </form>

      {invites.filter((i) => !i.accepted_at && new Date(i.expires_at).getTime() > Date.now()).length > 0 && (
        <>
          <h3 style={{ fontSize: 14, marginTop: 24, color: "#666", fontWeight: 500 }}>outstanding invites</h3>
          <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}>
            {invites
              .filter((i) => !i.accepted_at && new Date(i.expires_at).getTime() > Date.now())
              .map((i) => (
                <li key={i.token} style={{ fontSize: 12, color: "#666", padding: "4px 0", fontFamily: "ui-monospace, Menlo, monospace" }}>
                  {origin}/accept-invite/{i.token}
                  {i.label && <span style={{ color: "#888" }}> · {i.label}</span>}
                  <span style={{ color: "#aaa" }}> · expires {new Date(i.expires_at).toISOString().slice(0, 10)}</span>
                </li>
              ))}
          </ul>
        </>
      )}

      <h2 style={{ fontSize: 16, marginTop: 32 }}>new grant</h2>
      <form action={createShareAction} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
        <label>
          viewer email
          <input name="viewer_email" type="email" required style={inp} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>
            scope
            <select name="scope_type" defaultValue="all" style={inp}>
              <option value="all">all repos</option>
              <option value="repo_pattern">repo glob (e.g. client-*)</option>
              <option value="project">project id</option>
            </select>
          </label>
          <label style={{ flex: 2 }}>
            scope value (blank for all)
            <input name="scope_value" placeholder="client-*" style={inp} />
          </label>
        </div>
        <label>
          granularity
          <select name="granularity" defaultValue="weekly" style={inp}>
            <option value="realtime">realtime</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
          </select>
        </label>

        <fieldset style={{ border: "1px solid #ddd", padding: 12, borderRadius: 4 }}>
          <legend>fields (whitelist)</legend>
          <p style={{ margin: 0, color: "#888", fontSize: 12 }}>
            prompts, completions, and raw spans are never shareable — not on this list, not on any list.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 8 }}>
            {[...SHAREABLE_FIELDS].sort().map((f) => (
              <label key={f} style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  name="fields"
                  value={f}
                  defaultChecked={DEFAULT_FIELDS.includes(f)}
                />{" "}
                {f}
              </label>
            ))}
          </div>
        </fieldset>

        <button type="submit" style={btn}>create grant</button>
      </form>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>grants you've issued</h2>
      <GrantTable rows={owned} side="owned" />

      <h2 style={{ fontSize: 16, marginTop: 32 }}>grants you've been given</h2>
      <GrantTable rows={granted} side="granted" />
    </main>
  );
}

function GrantTable({ rows, side }: { rows: PeerShareRow[]; side: "owned" | "granted" }): ReactElement {
  if (rows.length === 0) {
    return <p style={{ color: "#888" }}>none yet.</p>;
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
          <th style={th}>{side === "owned" ? "viewer" : "owner"}</th>
          <th style={th}>scope</th>
          <th style={th}>granularity</th>
          <th style={th}>fields</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
            <td style={td}>{side === "owned" ? r.viewer_email : r.owner_email}</td>
            <td style={td}>{r.scope_type === "all" ? "all" : `${r.scope_type}: ${r.scope_value}`}</td>
            <td style={td}>{r.granularity}</td>
            <td style={{ ...td, color: "#666", fontSize: 12 }}>{r.fields.join(", ")}</td>
            <td style={td}>
              {side === "owned" ? (
                <form action={revokeShareAction}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" style={revokeBtn}>revoke</button>
                </form>
              ) : (
                <a href={`/?as=${r.owner_id}`} style={{ fontSize: 12 }}>view as them</a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const inp: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
  border: "1px solid #ccc",
  borderRadius: 4,
  marginTop: 4,
};
const btn: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "#111",
  color: "#fff",
  border: 0,
  borderRadius: 4,
  cursor: "pointer",
  width: "fit-content",
};
const revokeBtn: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  background: "transparent",
  color: "#c00",
  border: "1px solid #c00",
  borderRadius: 4,
  cursor: "pointer",
};
const th: React.CSSProperties = { padding: "8px 4px", fontSize: 13 };
const td: React.CSSProperties = { padding: "8px 4px", fontSize: 13 };
const inviteBanner: React.CSSProperties = {
  marginTop: 16,
  padding: "12px 14px",
  background: "#e7f6ec",
  border: "1px solid #84d6a4",
  borderRadius: 6,
  color: "#1a4f2a",
};
const inviteUrlBox: React.CSSProperties = {
  display: "block",
  marginTop: 8,
  padding: "10px 12px",
  background: "#fff",
  border: "1px solid #c0d8c8",
  borderRadius: 4,
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 12,
  wordBreak: "break-all",
  color: "#0a3318",
};
