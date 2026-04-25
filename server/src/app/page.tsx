/**
 * / — public landing page.
 *
 * Cyber/agentic concept piece. Server-rendered shell (HTML + critical
 * styles + copy ship as static), client-bound motion components hydrate
 * below. No auth required; logged-in visitors can still hit /app via
 * the top nav.
 *
 * Sections:
 *   1. Top nav (brand + sign-in CTA)
 *   2. Hero — left: tagline + tertiary copy; right: live TerminalHero
 *   3. Sources strip — Claude Code · ashlr-plugin · GitHub · git
 *   4. "ingest" section — three cards detailing each input
 *   5. Privacy floor — explicit list of what we never store
 *   6. "for cofounder-scale teams" — the why
 *   7. Final CTA + footer
 *
 * Design grammar:
 *   - jet-black canvas (#050505)
 *   - JetBrains Mono / system mono everywhere
 *   - green for code/spans, magenta for CTAs, cyan/amber/purple for
 *     event kinds (matches the terminal hero palette)
 *   - scanline overlay tinges the page subtly
 *   - all motion is short and intentional (200-600ms) — no parallax,
 *     no scroll-bound timelines, no flourish
 */

import type { ReactElement } from "react";
import { TerminalHero } from "@/components/landing/TerminalHero";
import { Reveal } from "@/components/landing/Reveal";
import { GlitchText } from "@/components/landing/GlitchText";

export const metadata = {
  title: "Pulse · shared mission control for agentic-engineering teams",
  description:
    "Cofounder-scale visibility across every repo and AI tool. Configurable peer-share. Hard privacy floor — we never store prompts, completions, or code.",
};

const MONO =
  "ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, monospace";

export default function Landing(): ReactElement {
  return (
    <div
      style={{
        background: "#050505",
        color: "#d8d8d8",
        minHeight: "100vh",
        fontFamily: MONO,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <PageScanlines />
      <BackgroundGrid />
      <BackgroundGlow />
      <ResponsiveStyles />

      <TopNav />

      <main style={{ position: "relative", zIndex: 1 }}>
        <Hero />
        <SourcesStrip />
        <IngestSection />
        <PrivacyFloor />
        <ForCofounders />
        <FinalCta />
      </main>

      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function TopNav(): ReactElement {
  return (
    <header
      style={{
        position: "relative",
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 32px",
        maxWidth: 1240,
        margin: "0 auto",
      }}
    >
      <a
        href="/"
        style={{
          fontFamily: MONO,
          fontWeight: 700,
          fontSize: 16,
          color: "#fff",
          textDecoration: "none",
          letterSpacing: "-0.5px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <PulseGlyph />
        pulse
        <span style={{ color: "#444", fontWeight: 400 }}>·</span>
        <span style={{ color: "#666", fontWeight: 400, fontSize: 13 }}>ashlr</span>
      </a>

      <nav style={{ display: "flex", gap: 24, alignItems: "center", fontSize: 13 }}>
        <a href="https://github.com/ashlrai/ashlr-pulse" style={navLink}>github</a>
        <a href="/login" style={navLink}>sign in</a>
        <a href="/login" className="pulse-magenta-cta" style={magentaCta}>
          start tracking →
        </a>
      </nav>
    </header>
  );
}

function Hero(): ReactElement {
  return (
    <section
      className="pulse-hero"
      style={{
        maxWidth: 1240,
        margin: "0 auto",
        padding: "80px 32px 100px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.05fr)",
        gap: 60,
        alignItems: "center",
      }}
    >
      <Reveal>
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 12px",
              border: "1px solid #1f1f1f",
              borderRadius: 999,
              fontSize: 11,
              color: "#7CFFA0",
              marginBottom: 28,
              fontFamily: MONO,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#7CFFA0" }} />
            v0.2 — peer-visibility live
          </div>

          <h1
            style={{
              fontFamily: MONO,
              fontSize: 56,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-2px",
              color: "#fff",
              margin: 0,
            }}
          >
            shared mission control
            <br />
            for{" "}
            <GlitchText style={{ color: "#7CFFA0" }}>agentic</GlitchText>
            -engineering teams.
          </h1>

          <p
            style={{
              marginTop: 24,
              fontSize: 16,
              lineHeight: 1.65,
              color: "#9a9a9a",
              maxWidth: 520,
            }}
          >
            Cofounder-scale visibility across every repo, every AI tool, every
            commit. Configurable peer-share. A privacy floor that's
            <span style={{ color: "#fff" }}> not a toggle</span> — we never store
            prompts, completions, or code.
          </p>

          <div style={{ marginTop: 36, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <a href="/login" style={{ ...magentaCta, padding: "12px 22px", fontSize: 14 }}>
              start tracking →
            </a>
            <a
              href="https://github.com/ashlrai/ashlr-pulse"
              style={{ ...secondaryCta, padding: "12px 22px", fontSize: 14 }}
            >
              read the source
            </a>
          </div>

          <div style={{ marginTop: 32, display: "flex", gap: 24, fontSize: 12, color: "#666" }}>
            <span>· OpenTelemetry-native</span>
            <span>· MIT core</span>
            <span>· Self-hostable</span>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.15}>
        <TerminalHero />
      </Reveal>
    </section>
  );
}

function SourcesStrip(): ReactElement {
  const sources = [
    { name: "Claude Code", color: "#7CD0FF" },
    { name: "ashlr-plugin", color: "#FFE07A" },
    { name: "GitHub commits + PRs", color: "#7CFFA0" },
    { name: "Cursor (soon)", color: "#666" },
    { name: "Copilot Metrics (soon)", color: "#666" },
    { name: "Windsurf (soon)", color: "#666" },
  ];
  return (
    <section
      style={{
        borderTop: "1px solid #111",
        borderBottom: "1px solid #111",
        padding: "20px 32px",
        background: "#080808",
      }}
    >
      <div
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 32,
          flexWrap: "wrap",
          fontSize: 12,
          color: "#666",
        }}
      >
        <span style={{ color: "#444", letterSpacing: 1 }}>SOURCES</span>
        {sources.map((s) => (
          <span key={s.name} style={{ color: s.color, fontFamily: MONO }}>
            {s.name}
          </span>
        ))}
      </div>
    </section>
  );
}

function IngestSection(): ReactElement {
  const cards = [
    {
      label: "AI activity",
      title: "every claude session, every model, every dollar.",
      body: "Native OpenTelemetry GenAI ingest at /api/otlp/v1/traces. Bearer-PAT-authenticated. Token counts in/out/cache, tool calls, model, repo. Zero prompts, zero completions, ever.",
      accent: "#7CD0FF",
      code: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=
   https://pulse.ashlr.ai/api/otlp/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=
   "authorization=Bearer pulse_pat_…"`,
    },
    {
      label: "GitHub",
      title: "commits, PRs, reviews — across every repo you own.",
      body: "Sign in with GitHub once; Pulse pulls last 30 days of commits and PRs across all your authorized repos and watermarks per-source for incremental syncs. Metadata only — no diffs, no descriptions, no comment text.",
      accent: "#7CFFA0",
      code: `github_event   ON CONFLICT (repo_id, kind, external_id)
                     DO NOTHING

kinds: commit | pr_opened | pr_merged | pr_closed`,
    },
    {
      label: "ashlr-plugin",
      title: "the savings layer.",
      body: "If you use the ashlr-plugin Claude Code plugin (open-source, MIT), it auto-emits compact spans with tokens_saved per tool call. Pulse stores them under a dedicated source so the dashboard can attribute savings to specific tools.",
      accent: "#FFE07A",
      code: `ashlr.plugin.tokens_saved → activity_event.tokens_saved
ashlr.plugin.session_id   → claude.session.id (override)
ashlr.plugin.repo         → claude.repo.name  (override)`,
    },
  ];

  return (
    <section style={{ maxWidth: 1240, margin: "0 auto", padding: "120px 32px 60px" }}>
      <Reveal>
        <SectionHeader
          eyebrow="01 / ingest"
          title="one endpoint. every signal."
          subtitle="Pulse speaks OpenTelemetry GenAI semantic conventions. So do most of the AI tools you already use, or will soon."
        />
      </Reveal>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
          marginTop: 48,
        }}
      >
        {cards.map((c, i) => (
          <Reveal key={c.label} delay={i * 0.1}>
            <article
              className="pulse-card"
              style={{
                background: "#0a0a0a",
                border: "1px solid #1a1a1a",
                borderRadius: 10,
                padding: 24,
                height: "100%",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: 1,
                  color: c.accent,
                  textTransform: "uppercase",
                }}
              >
                {c.label}
              </div>
              <h3
                style={{
                  fontFamily: MONO,
                  fontSize: 18,
                  fontWeight: 600,
                  color: "#fff",
                  margin: "8px 0 12px",
                  lineHeight: 1.3,
                  letterSpacing: "-0.3px",
                }}
              >
                {c.title}
              </h3>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "#888", margin: 0 }}>
                {c.body}
              </p>
              <pre
                style={{
                  marginTop: 18,
                  padding: 12,
                  background: "#050505",
                  border: "1px solid #181818",
                  borderRadius: 6,
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: c.accent,
                  overflowX: "auto",
                  margin: "18px 0 0",
                }}
              >
                {c.code}
              </pre>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function PrivacyFloor(): ReactElement {
  const NEVER = [
    "prompts",
    "completions",
    "user code · file contents · diffs",
    "stdout / stderr",
    "screenshots",
    "keystrokes",
    "AFK / idle metrics",
  ];
  return (
    <section
      className="pulse-privacy"
      style={{
        maxWidth: 1240,
        margin: "0 auto",
        padding: "60px 32px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)",
        gap: 60,
        alignItems: "center",
      }}
    >
      <Reveal>
        <SectionHeader
          eyebrow="02 / privacy floor"
          title={
            <>
              not a toggle.
              <br />
              not a setting.
              <br />
              <GlitchText style={{ color: "#FF60D6" }}>not negotiable.</GlitchText>
            </>
          }
          subtitle="Most observability tools start with 'we collect everything, you can opt out.' We start with the inverse: we collect what's safe by default and the dangerous things never enter the system."
        />
      </Reveal>
      <Reveal delay={0.15}>
        <div
          style={{
            background:
              "radial-gradient(120% 100% at 50% 0%, rgba(255,96,214,0.06) 0%, rgba(255,96,214,0) 50%), #0a0a0a",
            border: "1px solid #1f0d18",
            borderRadius: 12,
            padding: 32,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 1.5,
              color: "#FF60D6",
              textTransform: "uppercase",
              marginBottom: 16,
            }}
          >
            things Pulse will never store
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
            {NEVER.map((item) => (
              <li
                key={item}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontSize: 14,
                  color: "#d8d8d8",
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    color: "#FF60D6",
                    fontSize: 12,
                  }}
                >
                  ✕
                </span>
                {item}
              </li>
            ))}
          </ul>
          <p
            style={{
              marginTop: 24,
              paddingTop: 18,
              borderTop: "1px solid #1f1f1f",
              fontSize: 12,
              color: "#666",
              lineHeight: 1.7,
            }}
          >
            Enforced at the schema layer (column absence) and at the API
            layer (<span style={{ color: "#7CFFA0" }}>peer-share-guard.ts</span> rejects
            forbidden field names with 422 before the DB ever sees them).
          </p>
        </div>
      </Reveal>
    </section>
  );
}

function ForCofounders(): ReactElement {
  const points = [
    {
      title: "1 to 20 engineers, not 1,000.",
      body: "Built for the team that's still small enough to know everyone's name. We don't sell to VPs of Engineering chasing DORA metrics. We sell to founders who want to know what their cofounder shipped while they slept.",
    },
    {
      title: "configurable peer-share, asymmetric by default.",
      body: "Mason's cofounder can see Mason's client-* repos in real-time, but only weekly aggregates of his SaaS work. Different scopes, different granularities, different field whitelists — per peer, per repo glob.",
    },
    {
      title: "agents are first-class actors.",
      body: "When @agent[claude] commits, Pulse records it as such. The dashboard's actor breakdown shows you, your cofounder, and every agent on equal footing — because in 2026, that's what your team actually looks like.",
    },
  ];
  return (
    <section
      style={{
        maxWidth: 1240,
        margin: "0 auto",
        padding: "80px 32px",
      }}
    >
      <Reveal>
        <SectionHeader
          eyebrow="03 / why pulse"
          title="for the team you actually have."
          subtitle="There are eight tools that show you DORA scores and burn-down charts. There's none that show you, your cofounder, and your agents on the same canvas."
          align="center"
        />
      </Reveal>
      <div
        style={{
          marginTop: 48,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 24,
        }}
      >
        {points.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.08}>
            <div style={{ padding: "24px 0" }}>
              <h3
                style={{
                  fontFamily: MONO,
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#fff",
                  margin: "0 0 12px",
                  letterSpacing: "-0.3px",
                }}
              >
                {p.title}
              </h3>
              <p style={{ fontSize: 13, lineHeight: 1.7, color: "#888", margin: 0 }}>
                {p.body}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function FinalCta(): ReactElement {
  return (
    <section
      style={{
        maxWidth: 920,
        margin: "60px auto 80px",
        padding: "80px 32px",
        background:
          "radial-gradient(80% 100% at 50% 0%, rgba(255,96,214,0.08), rgba(124,255,160,0.04) 50%, transparent 70%)",
        border: "1px solid #1a1a1a",
        borderRadius: 14,
        textAlign: "center",
      }}
    >
      <Reveal>
        <h2
          style={{
            fontFamily: MONO,
            fontSize: 36,
            fontWeight: 700,
            color: "#fff",
            margin: 0,
            letterSpacing: "-1px",
            lineHeight: 1.15,
          }}
        >
          stop pinging your cofounder
          <br />
          on Slack to ask{" "}
          <GlitchText style={{ color: "#7CFFA0" }}>"what'd you ship?"</GlitchText>
        </h2>
        <p style={{ marginTop: 20, color: "#888", fontSize: 14, maxWidth: 540, marginInline: "auto" }}>
          One dashboard, every repo, every AI tool, every actor. Configurable
          peer-share. Open-source core. Self-hostable.
        </p>
        <div style={{ marginTop: 32, display: "flex", justifyContent: "center", gap: 12 }}>
          <a href="/login" style={{ ...magentaCta, padding: "14px 28px", fontSize: 15 }}>
            start tracking →
          </a>
        </div>
      </Reveal>
    </section>
  );
}

function Footer(): ReactElement {
  return (
    <footer
      style={{
        borderTop: "1px solid #111",
        padding: "32px",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 16,
          fontSize: 12,
          color: "#555",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <PulseGlyph />
          <span style={{ color: "#888" }}>pulse</span>
          <span>·</span>
          <a href="https://ashlr.ai" style={{ color: "#888", textDecoration: "none" }}>
            an ashlr.ai product
          </a>
          <span>·</span>
          <span>MIT core</span>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          <a href="/privacy" style={navLink}>privacy</a>
          <a href="https://github.com/ashlrai/ashlr-pulse" style={navLink}>github</a>
          <a href="/login" style={navLink}>sign in</a>
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Shared landing primitives
// ---------------------------------------------------------------------------

function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = "left",
}: {
  eyebrow: string;
  title: ReactElement | string;
  subtitle?: string;
  align?: "left" | "center";
}): ReactElement {
  return (
    <div style={{ textAlign: align, maxWidth: align === "center" ? 720 : 640, margin: align === "center" ? "0 auto" : 0 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: 1.5,
          color: "#7CFFA0",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        {eyebrow}
      </div>
      <h2
        style={{
          fontFamily: MONO,
          fontSize: 36,
          fontWeight: 700,
          color: "#fff",
          margin: 0,
          letterSpacing: "-1px",
          lineHeight: 1.15,
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          style={{
            marginTop: 16,
            fontSize: 15,
            lineHeight: 1.65,
            color: "#888",
            maxWidth: 580,
            marginInline: align === "center" ? "auto" : 0,
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

function PulseGlyph(): ReactElement {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
      <rect width={24} height={24} rx={5} fill="#0a0a0a" stroke="#1f1f1f" />
      <path
        d="M4 14 L8 14 L9.5 9 L12 18 L13.5 12 L16 12 L17.5 10 L20 10"
        stroke="#7CFFA0"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function ResponsiveStyles(): ReactElement {
  return (
    <style>{`
      @media (max-width: 860px) {
        .pulse-hero, .pulse-privacy {
          grid-template-columns: 1fr !important;
          gap: 40px !important;
          padding: 48px 24px !important;
        }
        .pulse-hero h1 {
          font-size: 38px !important;
          letter-spacing: -1px !important;
        }
        .pulse-section-title {
          font-size: 26px !important;
          letter-spacing: -0.5px !important;
        }
        .pulse-final-cta h2 {
          font-size: 24px !important;
        }
        .pulse-nav {
          gap: 16px !important;
          padding: 16px 20px !important;
        }
        .pulse-nav-link[data-mobile-hide] {
          display: none !important;
        }
      }
      @media (max-width: 540px) {
        .pulse-hero h1 {
          font-size: 30px !important;
        }
        .pulse-final-cta h2 {
          font-size: 20px !important;
        }
      }
      /* CTA hover glow */
      .pulse-magenta-cta {
        transition: transform 150ms cubic-bezier(.2,.8,.2,1), box-shadow 150ms;
      }
      .pulse-magenta-cta:hover {
        transform: translateY(-1px);
        box-shadow: 0 0 0 1px rgba(255,96,214,0.35), 0 14px 32px -4px rgba(255,96,214,0.55) !important;
      }
      .pulse-card {
        transition: border-color 150ms, transform 150ms;
      }
      .pulse-card:hover {
        border-color: #2a2a2a !important;
        transform: translateY(-2px);
      }
    `}</style>
  );
}

function PageScanlines(): ReactElement {
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
          "radial-gradient(ellipse at 50% 0%, black 0%, black 30%, transparent 70%)",
        WebkitMaskImage:
          "radial-gradient(ellipse at 50% 0%, black 0%, black 30%, transparent 70%)",
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
        top: -200,
        left: "50%",
        transform: "translateX(-50%)",
        width: 1200,
        height: 600,
        background:
          "radial-gradient(50% 50% at 50% 50%, rgba(124,255,160,0.06) 0%, rgba(124,255,160,0) 70%)",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Style tokens
// ---------------------------------------------------------------------------

const navLink: React.CSSProperties = {
  color: "#aaa",
  textDecoration: "none",
  fontFamily: MONO,
};

const magentaCta: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 16px",
  background: "linear-gradient(180deg, #FF60D6 0%, #d645b1 100%)",
  color: "#0a0010",
  textDecoration: "none",
  fontWeight: 600,
  fontFamily: MONO,
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid rgba(255,96,214,0.4)",
  boxShadow: "0 0 0 1px rgba(255,96,214,0.2), 0 8px 24px -4px rgba(255,96,214,0.4)",
};

const secondaryCta: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 16px",
  background: "transparent",
  color: "#d8d8d8",
  textDecoration: "none",
  fontWeight: 500,
  fontFamily: MONO,
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid #2a2a2a",
};
