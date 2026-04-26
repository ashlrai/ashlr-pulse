/**
 * /agent-onboard?code=XXXXXXXX — approval UI for the browser-mediated
 * agent onboarding flow.
 *
 * Three states:
 *   1. No session            → redirect to /login?next=/agent-onboard?code=...
 *   2. Code missing/invalid  → friendly error
 *   3. Otherwise             → show the code + agent label, "Approve" button
 *
 * Approving POSTs to /api/agent-onboard/approve with the code; the route
 * marks the row approved and we land on a "code is approved, return to
 * your terminal" success page.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { Header } from "@/components/Header";
import { approveCode, getCode } from "@/lib/agent-onboard-db";

export const dynamic = "force-dynamic";

interface SearchParams {
  code?: string;
  approved?: string;
  error?: string;
}

async function approveAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login?next=/agent-onboard");

  const code = String(formData.get("code") ?? "").trim();
  if (!/^[A-Z2-9]{8}$/.test(code)) {
    redirect(`/agent-onboard?error=${encodeURIComponent("invalid code")}`);
  }

  const ok = await approveCode(code, me.id);
  if (!ok) {
    redirect(`/agent-onboard?code=${code}&error=${encodeURIComponent("code expired or already used")}`);
  }
  revalidatePath("/agent-onboard");
  redirect(`/agent-onboard?code=${code}&approved=1`);
}

export default async function AgentOnboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const me = await currentUser();
  const params = await searchParams;
  const code = (params.code ?? "").toUpperCase();

  if (!me) {
    const next = `/agent-onboard${code ? `?code=${code}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!me) return <></>; // narrowing

  if (!/^[A-Z2-9]{8}$/.test(code)) {
    return (
      <Wrap me={me}>
        <h1 style={h1}>Agent onboarding</h1>
        <Card>
          <p style={{ color: "#666", margin: 0 }}>
            No code in the URL. Run <code style={code_}>pulse-agent init --url …</code> in your
            terminal — it will print a link that brings you back here with the code.
          </p>
        </Card>
      </Wrap>
    );
  }

  const row = await getCode(code);
  const expired = !!row && new Date(row.expires_at).getTime() < Date.now();

  if (params.approved === "1") {
    return (
      <Wrap me={me}>
        <h1 style={h1}>Code <code style={code_}>{code}</code> approved</h1>
        <Card>
          <p style={{ margin: 0, color: "#1a7f3a" }}>
            Your terminal will pick up the credential within a few seconds. You can
            close this tab.
          </p>
        </Card>
      </Wrap>
    );
  }

  return (
    <Wrap me={me}>
      <h1 style={h1}>Approve agent</h1>

      {params.error && (
        <div style={{ background: "#fdecea", color: "#a02622", padding: "10px 12px", borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          {params.error}
        </div>
      )}

      <Card>
        <div style={{ marginBottom: 16, color: "#666", fontSize: 13 }}>
          A pulse-agent on this code is asking to mint a personal access token
          for your account. Confirm the code matches what your terminal printed,
          then approve.
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>code</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, Menlo, monospace", letterSpacing: "0.1em" }}>{code}</div>
        </div>

        {row?.agent_label && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>agent label</div>
            <div style={{ fontSize: 14 }}>{row.agent_label}</div>
          </div>
        )}

        <div style={{ marginBottom: 16, fontSize: 12, color: "#666" }}>
          {!row || expired
            ? <span style={{ color: "#a02622" }}>This code has expired or doesn&apos;t exist. Re-run <code style={code_}>pulse-agent init</code>.</span>
            : <>Expires {new Date(row.expires_at).toLocaleString()}.</>}
        </div>

        <form action={approveAction}>
          <input type="hidden" name="code" value={code} />
          <button
            type="submit"
            disabled={!row || expired}
            style={{
              ...primaryBtn,
              opacity: !row || expired ? 0.5 : 1,
              cursor: !row || expired ? "not-allowed" : "pointer",
            }}
          >
            Approve agent
          </button>
        </form>
      </Card>
    </Wrap>
  );
}

function Wrap({ me, children }: { me: { email: string; id: string; name: string | null }; children: React.ReactNode }): ReactElement {
  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "0 24px", fontFamily: "ui-monospace, Menlo, monospace" }}>
      <Header me={me} active="settings" />
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }): ReactElement {
  return <div style={card}>{children}</div>;
}

const h1: React.CSSProperties = { fontSize: 22, fontWeight: 600, margin: "8px 0 16px" };
const card: React.CSSProperties = { border: "1px solid #ececec", borderRadius: 8, padding: 20, background: "#fff" };
const primaryBtn: React.CSSProperties = {
  background: "#111", color: "#fff", border: "none", borderRadius: 4,
  padding: "10px 18px", fontSize: 13, fontFamily: "inherit",
};
const code_: React.CSSProperties = { background: "#f1f3f5", padding: "1px 6px", borderRadius: 3, fontSize: "0.92em" };
