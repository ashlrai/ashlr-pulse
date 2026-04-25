/**
 * /privacy — long-form, cyber-themed elaboration of the privacy floor.
 *
 * The landing page mentions it; this page explains *exactly* what's
 * stored, where, and how each guarantee is enforced. Public — no auth
 * needed.
 */

import type { ReactElement } from "react";
import { Reveal } from "@/components/landing/Reveal";

const MONO = "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace";

export const metadata = {
  title: "Pulse · privacy floor",
  description:
    "What Pulse stores, what it never stores, and how each guarantee is enforced — at the schema, the API, and the agent. Not a toggle. Not a setting. Not negotiable.",
};

export default function PrivacyPage(): ReactElement {
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
      <Scanlines />
      <Grid />

      <header
        style={{
          padding: "20px 32px",
          maxWidth: 880,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "relative",
          zIndex: 1,
        }}
      >
        <a href="/" style={brand}>
          <Glyph />
          <span style={{ marginLeft: 10 }}>pulse</span>
        </a>
        <a href="/" style={{ color: "#aaa", textDecoration: "none", fontSize: 13 }}>← back</a>
      </header>

      <main
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "60px 32px 80px",
          position: "relative",
          zIndex: 1,
        }}
      >
        <Reveal>
          <div
            style={{
              fontSize: 11,
              letterSpacing: 1.5,
              color: "#7CFFA0",
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            privacy floor
          </div>
          <h1
            style={{
              fontSize: 44,
              fontWeight: 700,
              letterSpacing: "-1.5px",
              lineHeight: 1.1,
              color: "#fff",
              margin: 0,
            }}
          >
            not a toggle. not a setting. not negotiable.
          </h1>
          <p style={{ marginTop: 20, fontSize: 16, lineHeight: 1.7, color: "#9a9a9a" }}>
            Most observability tools start with "we collect everything; you can
            opt out." Pulse starts with the inverse: we collect what's safe by
            default, and the dangerous things never enter the system in the
            first place.
          </p>
          <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.7, color: "#666" }}>
            Below is the exact list of what's stored, what isn't, and where
            each guarantee is enforced. If anything below ever stops being
            true, that's a bug — open an issue at{" "}
            <a href="https://github.com/ashlrai/ashlr-pulse" style={{ color: "#7CFFA0" }}>
              ashlrai/ashlr-pulse
            </a>
            .
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <Section title="what Pulse never stores" tone="forbidden">
            <NeverList
              items={[
                ["prompts", "the text you sent to the LLM"],
                ["completions", "the text the LLM sent back"],
                ["user code · file contents · diffs", "no hunks, no patches, no source"],
                ["stdout / stderr", "the agent's tool outputs aren't shipped"],
                ["screenshots / window captures", "we don't observe your screen"],
                ["keystrokes / per-key telemetry", "no input layer instrumentation"],
                ["AFK / idle / typing-rhythm metrics", "no presence surveillance"],
                ["commit bodies · PR descriptions · review comment text", "GitHub data is metadata only"],
              ]}
            />
            <Callout>
              Enforced at the <strong style={code}>activity_event</strong> +{" "}
              <strong style={code}>github_event</strong> schema layers (column absence) and at
              the API layer in{" "}
              <strong style={code}>lib/peer-share-guard.ts</strong> — peer-share
              creation rejects any field name in the forbidden list with HTTP 422
              before the row reaches the database.
            </Callout>
          </Section>
        </Reveal>

        <Reveal delay={0.15}>
          <Section title="what Pulse does store" tone="allowed">
            <AllowedList
              items={[
                ["timestamp · session id · source · model", "structural metadata about each event"],
                ["token counts (in / out / cache read / cache write)", "for cost and volume reporting"],
                ["tool call counts + tool names", "what kinds of tools were invoked, never their arguments or output"],
                ["repo name + git branch + project hash (sha256)", "the cwd is hashed before it leaves the machine"],
                ["language", "for stack-mix reporting"],
                ["commit SHA · PR number · PR state · diff line counts", "GitHub events as enums + integers"],
                ["commit subject (first line, ≤200 chars)", "the only freeform string we record from GitHub — used solely for the activity feed"],
                ["tokens_saved (when emitted by ashlr-plugin)", "how much was avoided via the plugin's caching layer"],
              ]}
            />
            <Callout>
              GenAI semantic conventions{" "}
              <a
                href="https://opentelemetry.io/docs/specs/semconv/gen-ai/"
                style={{ color: "#7CFFA0" }}
              >
                (OpenTelemetry)
              </a>
              . Every column maps to a public OTel attribute, so any compliant
              tool can ingest into Pulse and Pulse data can flow out into
              Datadog / Honeycomb / Grafana without rewiring.
            </Callout>
          </Section>
        </Reveal>

        <Reveal delay={0.2}>
          <Section title="how peer-share keeps the floor" tone="allowed">
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "#bdbdbd", margin: 0 }}>
              Peer-share grants are <em>per-peer, per-scope, per-granularity, per-field</em>.
              When you share with a cofounder, you pick which columns they see. The
              never-store list isn't on the menu — those columns don't exist on{" "}
              <strong style={code}>activity_event</strong>, so they can't be in any
              grant's <strong style={code}>fields[]</strong> array even if a malicious
              client requests them.
            </p>
            <p
              style={{
                marginTop: 14,
                fontSize: 14,
                lineHeight: 1.7,
                color: "#bdbdbd",
              }}
            >
              Default is private. Sharing is explicit, asymmetric, and revocable.
              Revoking is a UPDATE on{" "}
              <strong style={code}>peer_share.revoked_at</strong> — the next dashboard
              render and the next viewer query won't surface that grant.
            </p>
          </Section>
        </Reveal>

        <Reveal delay={0.25}>
          <Section title="encryption + secrets" tone="allowed">
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "#bdbdbd", margin: 0 }}>
              GitHub access tokens are encrypted at rest with AES-256-GCM via{" "}
              <strong style={code}>lib/token-crypto.ts</strong>. Personal Access
              Tokens (used by the Rust agent + ashlr-plugin) are stored as
              SHA-256 hashes — we cannot reproduce the plaintext after creation;
              you see it exactly once at mint time.
            </p>
            <p
              style={{
                marginTop: 14,
                fontSize: 14,
                lineHeight: 1.7,
                color: "#bdbdbd",
              }}
            >
              All HTTP traffic is TLS. Cookies are HttpOnly + SameSite=Lax. We
              never log request bodies — they may carry OTel payloads which are
              metadata-only by design but the principle of least logging still
              applies.
            </p>
          </Section>
        </Reveal>

        <Reveal delay={0.3}>
          <Section title="open source · self-hostable" tone="allowed">
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "#bdbdbd", margin: 0 }}>
              The core is MIT-licensed at{" "}
              <a
                href="https://github.com/ashlrai/ashlr-pulse"
                style={{ color: "#7CFFA0" }}
              >
                github.com/ashlrai/ashlr-pulse
              </a>
              . You can run Pulse against your own Postgres + Supabase project.
              The hosted version at <strong style={code}>pulse.ashlr.ai</strong> is
              the same source, deployed on Railway. Choose the trust model that
              fits.
            </p>
          </Section>
        </Reveal>

        <Reveal delay={0.35}>
          <div
            style={{
              marginTop: 60,
              padding: 20,
              background: "rgba(255, 96, 214, 0.05)",
              border: "1px solid rgba(255, 96, 214, 0.2)",
              borderRadius: 8,
              fontSize: 12,
              color: "#aaa",
              lineHeight: 1.7,
            }}
          >
            <strong style={{ color: "#FF60D6" }}>Found something we missed?</strong>{" "}
            File an issue or PR. The schema, the guard, and this page should
            stay in sync. If they ever drift, this page is wrong — open an issue.
          </div>
        </Reveal>
      </main>
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "forbidden" | "allowed";
  children: React.ReactNode;
}): ReactElement {
  return (
    <section
      style={{
        marginTop: 60,
        paddingTop: 32,
        borderTop: "1px solid #1a1a1a",
      }}
    >
      <h2
        className="pulse-section-title"
        style={{
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: "-0.4px",
          color: "#fff",
          margin: 0,
          marginBottom: 18,
        }}
      >
        <span style={{ color: tone === "forbidden" ? "#FF60D6" : "#7CFFA0" }}>{tone === "forbidden" ? "✕" : "✓"}</span>{" "}
        {title}
      </h2>
      {children}
    </section>
  );
}

function NeverList({ items }: { items: [string, string][] }): ReactElement {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 14 }}>
      {items.map(([term, def]) => (
        <li key={term} style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 10 }}>
          <span style={{ color: "#FF60D6", fontFamily: MONO, fontSize: 13, lineHeight: 1.6 }}>✕</span>
          <span style={{ fontSize: 14, lineHeight: 1.6, color: "#d8d8d8" }}>
            <strong style={{ color: "#fff" }}>{term}</strong>{" "}
            <span style={{ color: "#888" }}>— {def}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function AllowedList({ items }: { items: [string, string][] }): ReactElement {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 14 }}>
      {items.map(([term, def]) => (
        <li key={term} style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 10 }}>
          <span style={{ color: "#7CFFA0", fontFamily: MONO, fontSize: 13, lineHeight: 1.6 }}>✓</span>
          <span style={{ fontSize: 14, lineHeight: 1.6, color: "#d8d8d8" }}>
            <strong style={{ color: "#fff" }}>{term}</strong>{" "}
            <span style={{ color: "#888" }}>— {def}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Callout({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div
      style={{
        marginTop: 18,
        padding: "14px 16px",
        background: "rgba(124, 255, 160, 0.04)",
        border: "1px solid rgba(124, 255, 160, 0.15)",
        borderRadius: 6,
        fontSize: 13,
        color: "#aaa",
        lineHeight: 1.7,
      }}
    >
      {children}
    </div>
  );
}

function Glyph(): ReactElement {
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

function Grid(): ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)",
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

const code: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: "0.92em",
  background: "#0a0a0a",
  border: "1px solid #1a1a1a",
  padding: "1px 6px",
  borderRadius: 4,
  color: "#7CFFA0",
};
