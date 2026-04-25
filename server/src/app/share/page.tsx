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
  type PeerShareRow,
} from "@/lib/peer-share-db";
import { validateFields, SHAREABLE_FIELDS } from "@/lib/peer-share-guard";
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

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const [owned, granted] = await Promise.all([
    listGrantsOwnedBy(me.id),
    listGrantsForViewer(me.id),
  ]);
  const { ok, error } = await searchParams;

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 32,
        maxWidth: 960,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 24 }}>Pulse · sharing</h1>
      <p style={{ color: "#666", marginTop: 4 }}>
        you: <code>{me.email}</code>
      </p>

      {ok && <p style={{ color: "#080" }}>grant created.</p>}
      {error && <p style={{ color: "#c00" }}>error: {error}</p>}

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
