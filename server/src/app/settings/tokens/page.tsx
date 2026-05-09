/**
 * /settings/tokens — manage personal access tokens.
 *
 * Mint a new PAT via /api/pat so the plaintext token is shown exactly once
 * from the response body, never in a URL. Revoke button per row.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { listPats, revokePat, type PatRow } from "@/lib/pat";

import { Header } from "@/components/Header";
import { DashboardShell } from "@/components/ui/DashboardShell";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { palette, space } from "@/lib/theme";
import { TokenMintForm } from "./TokenMintForm";

export const dynamic = "force-dynamic";

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
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const pats = await listPats(me.id);
  const { error } = await searchParams;

  return (
    <DashboardShell maxWidth={840}>
      <Header me={me} active="tokens" />
      <h1 style={pageTitle}>personal access tokens</h1>
      <p style={pageSub}>
        ingest-only credentials for the Rust agent, ashlr-plugin, or any other OTLP source.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.x4 }}>
        {error && <Banner variant="danger">{error.replace(/\+/g, " ")}</Banner>}

        <TokenMintForm />

        <Card>
          <CardHeader title={`active tokens · ${pats.length}`} />
          {pats.length === 0 ? (
            <div style={{ padding: `${space.x3}px 0`, color: palette.textDim, fontSize: 13, lineHeight: 1.6 }}>
              <div style={{ color: palette.text, marginBottom: space.x1 }}>No tokens yet.</div>
              Create a Personal Access Token above to authorize the local
              {" "}<code style={{ color: palette.cyan }}>pulse-agent</code>{" "}
              to send OTLP spans to this server. The token is shown once at
              creation — copy it then; it&apos;s SHA-256 hashed in storage
              and can&apos;t be recovered.
            </div>
          ) : (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
                  <th style={th}>name</th>
                  <th style={th}>scopes</th>
                  <th style={th}>created</th>
                  <th style={th}>last used</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {pats.map((p: PatRow) => (
                  <tr key={p.id} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                    <td style={td}>{p.name}</td>
                    <td style={td}>
                      <code style={{ color: palette.cyan }}>{p.scopes.join(", ")}</code>
                    </td>
                    <td style={td}>
                      <code style={{ color: palette.textDim }}>
                        {new Date(p.created_at).toLocaleDateString()}
                      </code>
                    </td>
                    <td style={td}>
                      {p.last_used_at
                        ? <code style={{ color: palette.green }}>{new Date(p.last_used_at).toLocaleDateString()}</code>
                        : <span style={{ color: palette.textMute }}>—</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <form action={revokeAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <Button type="submit" variant="danger" size="sm">revoke</Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
const th: React.CSSProperties = {
  padding: "8px 6px", color: palette.textDim,
  fontSize: 11, fontWeight: 500, letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const td: React.CSSProperties = { padding: "8px 6px", color: palette.text };
