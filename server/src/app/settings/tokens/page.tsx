/**
 * /settings/tokens — manage personal access tokens.
 *
 * Mint a new PAT (name field). After creation the plaintext token is shown
 * exactly once via a `?token=<value>` flash param — we cannot recover it
 * later. Revoke button per row.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { mintPat, listPats, revokePat, type PatRow } from "@/lib/pat";
import { signOutAction } from "@/lib/auth-actions";

export const dynamic = "force-dynamic";

async function mintAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/settings/tokens?error=name+required");
  const minted = await mintPat(me.id, name);
  revalidatePath("/settings/tokens");
  redirect(`/settings/tokens?token=${encodeURIComponent(minted.token)}`);
}

async function revokeAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await revokePat(id, me.id);
  revalidatePath("/settings/tokens");
}

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const pats = await listPats(me.id);
  const { token: flashToken, error } = await searchParams;

  return (
    <main style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: 32, maxWidth: 800 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Pulse · tokens</h1>
      <p style={{ color: "#666", marginTop: 4 }}>
        you: <code>{me.email}</code> · <a href="/">dashboard →</a> ·{" "}
        <form action={signOutAction} style={{ display: "inline" }}>
          <button type="submit" style={{ background: "none", border: "none", cursor: "pointer", color: "#666", fontSize: "inherit", padding: 0 }}>sign out</button>
        </form>
      </p>

      {flashToken && (
        <div style={{ marginTop: 16, padding: "12px 16px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 4 }}>
          <p style={{ margin: 0, fontWeight: 600, color: "#166534" }}>token created — copy it now, it won't be shown again.</p>
          <code style={{ display: "block", marginTop: 8, wordBreak: "break-all", fontSize: 13, color: "#14532d" }}>{flashToken}</code>
        </div>
      )}
      {error && <p style={{ color: "#c00", marginTop: 8 }}>error: {error}</p>}

      <h2 style={{ fontSize: 16, marginTop: 32 }}>new token</h2>
      <form action={mintAction} style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 480 }}>
        <label style={{ flex: 1 }}>
          name
          <input name="name" type="text" required placeholder="laptop, CI, etc." style={inp} />
        </label>
        <button type="submit" style={btn}>create</button>
      </form>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>active tokens</h2>
      {pats.length === 0 ? (
        <p style={{ color: "#888" }}>no active tokens.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={th}>name</th>
              <th style={th}>created</th>
              <th style={th}>last used</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {pats.map((p: PatRow) => (
              <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={td}>{p.name}</td>
                <td style={td}>{new Date(p.created_at).toLocaleDateString()}</td>
                <td style={td}>{p.last_used_at ? new Date(p.last_used_at).toLocaleDateString() : "—"}</td>
                <td style={td}>
                  <form action={revokeAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button type="submit" style={revokeBtn}>revoke</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const inp: React.CSSProperties = { display: "block", width: "100%", padding: 8, fontSize: 13, fontFamily: "inherit", border: "1px solid #ccc", borderRadius: 4, marginTop: 4 };
const btn: React.CSSProperties = { padding: "10px 14px", fontSize: 13, fontFamily: "inherit", background: "#111", color: "#fff", border: 0, borderRadius: 4, cursor: "pointer" };
const revokeBtn: React.CSSProperties = { padding: "4px 8px", fontSize: 12, background: "transparent", color: "#c00", border: "1px solid #c00", borderRadius: 4, cursor: "pointer" };
const th: React.CSSProperties = { padding: "8px 4px", fontSize: 13 };
const td: React.CSSProperties = { padding: "8px 4px", fontSize: 13 };
