/**
 * /accept-invite/[token] — landing page for invite-link recipients.
 *
 * Three states:
 *   1. Token invalid / expired / consumed → friendly error + link home
 *   2. Token valid, viewer is unauthenticated → show "Sign in with
 *      GitHub" CTA, redirect carries the token through ?next=
 *   3. Token valid, viewer is authenticated → consume the token
 *      (acceptInvite), auto-create peer_share grant from suggestions,
 *      redirect to /app with a banner
 *
 * The "?accepted=1" suffix on /share lets the inviter see their fresh
 * grant immediately. The flow is consent-correct: the invitee is the
 * one who completes their own sign-in in their own browser.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/current-user";
import { acceptInvite, getInviteByToken } from "@/lib/invite-db";

export const dynamic = "force-dynamic";

interface RouteProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: RouteProps): Promise<ReactElement> {
  const { token } = await params;
  if (!/^[A-Z2-9]{16}$/.test(token)) {
    return <ErrorCard title="Invalid invite link" body="The token in this URL doesn't look right. Ask the person who sent it to generate a new one." />;
  }

  const invite = await getInviteByToken(token);
  if (!invite || new Date(invite.expires_at).getTime() < Date.now()) {
    return <ErrorCard title="Invite expired" body="This invite is no longer valid. Ask the inviter to generate a new one." />;
  }
  if (invite.accepted_at) {
    return <ErrorCard title="Already accepted" body="This invite has already been used. If that wasn't you, ask the inviter to send a fresh one." />;
  }

  const me = await currentUser();
  if (!me) {
    // Send them to login with a deep-link back to this page after auth.
    const next = encodeURIComponent(`/accept-invite/${token}`);
    return (
      <Wrap>
        <h1 style={h1}>You're invited to Pulse</h1>
        <p style={lede}>
          <strong style={{ color: "#fff" }}>{invite.owner_email}</strong> wants to share their agentic-engineering activity with you on Ashlr Pulse.
        </p>
        {invite.label && <p style={{ ...lede, color: "#999", fontSize: 13 }}>label: <code style={code}>{invite.label}</code></p>}
        <p style={{ ...lede, marginTop: 24 }}>
          Sign in with GitHub — Pulse pulls just your profile + email, no repo access at this step.
        </p>
        <a href={`/login?next=${next}`} style={primaryCta}>Sign in to accept →</a>
        <p style={{ marginTop: 20, fontSize: 12, color: "#666" }}>
          Privacy floor: Pulse never stores prompts, completions, file contents, or stdout. Only token counts, repo names, and commit metadata.
        </p>
      </Wrap>
    );
  }

  // Authenticated user → consume the token
  const result = await acceptInvite(token, me.id);
  if (!result.ok) {
    return <ErrorCard title="Couldn't accept invite" body={`Reason: ${result.reason}. Ask the inviter to send a fresh one.`} />;
  }

  const banner = result.createdShare
    ? `accepted=1&share=auto&from=${invite.owner_email}`
    : `accepted=1&from=${invite.owner_email}`;
  redirect(`/app?${banner}`);
}

function ErrorCard({ title, body }: { title: string; body: string }): ReactElement {
  return (
    <Wrap>
      <h1 style={h1}>{title}</h1>
      <p style={lede}>{body}</p>
      <a href="/" style={secondaryCta}>head home →</a>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <main style={{ minHeight: "100vh", background: "#050505", color: "#d8d8d8", fontFamily: "var(--font-mono), ui-monospace, Menlo, monospace", padding: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ maxWidth: 560, width: "100%", padding: "32px 28px", background: "#0a0a0a", border: "1px solid #1f1f1f", borderRadius: 8 }}>
        {children}
      </div>
    </main>
  );
}

const h1: React.CSSProperties = { margin: 0, fontSize: 22, fontWeight: 600, color: "#fff", letterSpacing: "-0.3px" };
const lede: React.CSSProperties = { marginTop: 12, fontSize: 14, lineHeight: 1.55, color: "#bbb" };
const primaryCta: React.CSSProperties = {
  display: "inline-block", marginTop: 18, padding: "12px 18px",
  background: "linear-gradient(180deg, #FF60D6 0%, #d645b1 100%)",
  color: "#0a0010", border: "1px solid rgba(255,96,214,0.4)",
  borderRadius: 6, fontSize: 14, fontWeight: 600, textDecoration: "none",
  boxShadow: "0 0 0 1px rgba(255,96,214,0.2), 0 8px 24px -4px rgba(255,96,214,0.4)",
};
const secondaryCta: React.CSSProperties = {
  display: "inline-block", marginTop: 16, padding: "10px 14px",
  background: "transparent", color: "#aaa",
  border: "1px solid #2a2a2a", borderRadius: 6, fontSize: 13,
  textDecoration: "none",
};
const code: React.CSSProperties = {
  background: "#1a1a1a", color: "#ddd", padding: "1px 6px",
  borderRadius: 3, fontSize: "0.92em",
};
