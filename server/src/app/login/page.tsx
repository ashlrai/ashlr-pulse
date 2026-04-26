/**
 * /login — magic-link sign-in, styled to match the landing.
 *
 * Dark canvas, monospace, scanline overlay, brand glyph at the top.
 * Same magenta CTA used across the marketing site. After successful
 * link → email, the user lands on /app via /auth/callback.
 *
 * GitHub sign-in arrives once the OAuth app is configured — when
 * GITHUB_OAUTH_CLIENT_ID is set the button renders, otherwise it
 * hides cleanly so users don't see a broken affordance.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { server } from "@/lib/supabase-server";

const MONO = "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace";

async function sendMagicLink(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return;

  // Allow callers to deep-link through the magic-link callback by passing
  // ?next= on the /login URL. Restrict to same-origin paths so we can't
  // be turned into an open redirect.
  const nextRaw = String(formData.get("next") ?? "").trim();
  const nextSafe = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "";

  const supabase = await server();
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const callback = nextSafe
    ? `${origin}/auth/callback?next=${encodeURIComponent(nextSafe)}`
    : `${origin}/auth/callback`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callback },
  });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}${nextSafe ? `&next=${encodeURIComponent(nextSafe)}` : ""}`);
  }
  redirect(`/login?sent=1${nextSafe ? `&next=${encodeURIComponent(nextSafe)}` : ""}`);
}

interface SearchParams {
  sent?: string;
  error?: string;
  next?: string;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const { sent, error, next } = await searchParams;
  const nextSafe = next && next.startsWith("/") && !next.startsWith("//") ? next : "";
  const githubOAuthEnabled = Boolean(process.env.GITHUB_OAUTH_CLIENT_ID);

  return (
    <div
      style={{
        background: "#050505",
        color: "#d8d8d8",
        minHeight: "100vh",
        fontFamily: MONO,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Scanlines />
      <BackgroundGrid />
      <BackgroundGlow />

      <header
        style={{
          padding: "24px 32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          maxWidth: 1240,
          margin: "0 auto",
          width: "100%",
          position: "relative",
          zIndex: 1,
        }}
      >
        <a href="/" style={brand}>
          <PulseGlyph />
          <span style={{ marginLeft: 10 }}>pulse</span>
          <span style={{ color: "#444", margin: "0 8px" }}>·</span>
          <span style={{ color: "#666", fontWeight: 400, fontSize: 13 }}>ashlr</span>
        </a>
        <a href="/" style={{ ...navLink, fontSize: 13 }}>
          ← back
        </a>
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            background: "rgba(10, 10, 10, 0.7)",
            backdropFilter: "blur(8px)",
            border: "1px solid #1a1a1a",
            borderRadius: 12,
            padding: 32,
            boxShadow:
              "0 30px 80px -20px rgba(124, 255, 160, 0.08), 0 10px 30px rgba(0, 0, 0, 0.5)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 1.5,
              color: "#7CFFA0",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            sign in
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 26,
              fontWeight: 700,
              color: "#fff",
              letterSpacing: "-0.5px",
              lineHeight: 1.2,
            }}
          >
            magic link to your inbox.
          </h1>
          <p style={{ color: "#888", marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
            no password. one click in your email and you're back here.
          </p>

          <form action={sendMagicLink} style={{ marginTop: 28 }}>
            {nextSafe && <input type="hidden" name="next" value={nextSafe} />}
            <label
              htmlFor="email"
              style={{ fontSize: 12, color: "#888", letterSpacing: 0.4 }}
            >
              email
            </label>
            <input
              id="email"
              type="email"
              name="email"
              placeholder="you@yourcompany.com"
              required
              autoFocus
              style={{
                display: "block",
                width: "100%",
                marginTop: 6,
                padding: "12px 14px",
                fontSize: 14,
                fontFamily: MONO,
                background: "#050505",
                border: "1px solid #2a2a2a",
                borderRadius: 6,
                color: "#fff",
                outline: "none",
              }}
            />
            <button type="submit" style={magentaCta}>
              send magic link →
            </button>
          </form>

          {githubOAuthEnabled && (
            <>
              <Divider />
              <a href="/api/github/oauth/start" style={githubCta}>
                <GitHubMark /> continue with github
              </a>
            </>
          )}

          {sent && (
            <p
              style={{
                marginTop: 18,
                padding: "10px 12px",
                background: "rgba(124, 255, 160, 0.08)",
                border: "1px solid rgba(124, 255, 160, 0.25)",
                borderRadius: 6,
                color: "#7CFFA0",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              ✓ check your email — link is good for one hour.
            </p>
          )}
          {error && (
            <p
              style={{
                marginTop: 18,
                padding: "10px 12px",
                background: "rgba(255, 96, 214, 0.08)",
                border: "1px solid rgba(255, 96, 214, 0.25)",
                borderRadius: 6,
                color: "#FF60D6",
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              ✕ {error}
            </p>
          )}

          <p style={{ marginTop: 24, fontSize: 11, color: "#555", lineHeight: 1.6 }}>
            we never store prompts, completions, or code. signing in just creates a
            session — nothing is collected from your machine until you connect a
            source.
          </p>
        </div>
      </main>
    </div>
  );
}

function Divider(): ReactElement {
  return (
    <div
      style={{
        margin: "20px 0",
        display: "flex",
        alignItems: "center",
        gap: 12,
        color: "#555",
        fontSize: 11,
      }}
    >
      <span style={{ flex: 1, height: 1, background: "#1a1a1a" }} />
      or
      <span style={{ flex: 1, height: 1, background: "#1a1a1a" }} />
    </div>
  );
}

function PulseGlyph(): ReactElement {
  return (
    <svg width={20} height={20} viewBox="0 0 32 32" aria-hidden>
      <rect width={32} height={32} rx={6} fill="#0a0a0a" stroke="#1f1f1f" />
      <path
        d="M4 17 L9 17 L11 11 L14.5 22 L16.5 14 L19 18 L21 14.5 L24 14.5 L26 11 L28 11"
        stroke="#7CFFA0"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function GitHubMark(): ReactElement {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="#fff" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.67 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.17a10.93 10.93 0 0 1 5.74 0c2.19-1.48 3.15-1.17 3.15-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.41-2.7 5.37-5.27 5.66.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function Scanlines(): ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        background:
          "repeating-linear-gradient(0deg, rgba(255,255,255,0.014) 0px, rgba(255,255,255,0.014) 1px, transparent 1px, transparent 4px)",
        zIndex: 0,
      }}
    />
  );
}

function BackgroundGrid(): ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
        backgroundSize: "44px 44px",
        backgroundPosition: "center top",
        maskImage:
          "radial-gradient(ellipse at 50% 30%, black 0%, black 30%, transparent 70%)",
        WebkitMaskImage:
          "radial-gradient(ellipse at 50% 30%, black 0%, black 30%, transparent 70%)",
        zIndex: 0,
      }}
    />
  );
}

function BackgroundGlow(): ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: -300,
        left: "50%",
        transform: "translateX(-50%)",
        width: 1000,
        height: 600,
        background:
          "radial-gradient(50% 50% at 50% 50%, rgba(124,255,160,0.05) 0%, rgba(124,255,160,0) 70%)",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}

const brand: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontFamily: MONO,
  fontWeight: 700,
  fontSize: 16,
  color: "#fff",
  textDecoration: "none",
  letterSpacing: "-0.5px",
};

const navLink: React.CSSProperties = {
  color: "#aaa",
  textDecoration: "none",
  fontFamily: MONO,
};

const magentaCta: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 14,
  padding: "12px 16px",
  background: "linear-gradient(180deg, #FF60D6 0%, #d645b1 100%)",
  color: "#0a0010",
  border: "1px solid rgba(255,96,214,0.4)",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: MONO,
  cursor: "pointer",
  textAlign: "center",
  boxShadow: "0 0 0 1px rgba(255,96,214,0.2), 0 8px 24px -4px rgba(255,96,214,0.4)",
};

const githubCta: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  width: "100%",
  padding: "12px 16px",
  background: "#1a1a1a",
  color: "#fff",
  border: "1px solid #2a2a2a",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: MONO,
  textDecoration: "none",
};
