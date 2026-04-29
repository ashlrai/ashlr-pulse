/**
 * Header.tsx — top nav for authenticated pages, cyber/agentic palette.
 *
 * Server component (zero client JS). Reads the current user from the
 * session via lib/current-user; renders only on pages that already
 * required auth.
 *
 * Layout: brand glyph + nav links on the left, agent-status pulse +
 * email + sign-out on the right. Active link gets a magenta underline
 * to mirror the landing's accent system.
 */

import type { ReactElement } from "react";
import { signOutAction } from "@/lib/auth-actions";
import type { CurrentUser } from "@/lib/current-user";
import { palette, space } from "@/lib/theme";

interface Props {
  me: CurrentUser;
  active: "dashboard" | "ask" | "github" | "share" | "projects" | "tokens" | "settings";
  /** Optional live agent status — renders the green pulse + label when alive. */
  agentAlive?: boolean;
  agentSeenSecondsAgo?: number | null;
}

export function Header({ me, active, agentAlive, agentSeenSecondsAgo }: Props): ReactElement {
  return (
    <header
      style={{
        display:        "flex",
        alignItems:     "center",
        justifyContent: "space-between",
        gap:            space.x4,
        padding:        `${space.x3}px 0`,
        borderBottom:   `1px solid ${palette.border}`,
        marginBottom:   space.x6,
        flexWrap:       "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.x4, flexWrap: "wrap", flex: "1 1 auto" }}>
        <a
          href="/app"
          style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
        >
          <BrandGlyph />
          <span
            style={{
              fontSize:       16,
              fontWeight:     600,
              letterSpacing:  "-0.3px",
              color:          palette.text,
            }}
          >
            Pulse
          </span>
        </a>
        <nav style={{ display: "flex", gap: space.x4, fontSize: 12 }}>
          <NavLink href="/app"             active={active === "dashboard"}>dashboard</NavLink>
          <NavLink href="/ask"             active={active === "ask"}>ask</NavLink>
          <NavLink href="/projects"        active={active === "projects"}>projects</NavLink>
          <NavLink href="/share"           active={active === "share"}>sharing</NavLink>
          <NavLink href="/github"          active={active === "github"}>github</NavLink>
          <NavLink href="/settings"        active={active === "settings"}>settings</NavLink>
          <NavLink href="/settings/tokens" active={active === "tokens"}>tokens</NavLink>
        </nav>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space.x3, fontSize: 12 }}>
        <AgentBadge alive={agentAlive} seen={agentSeenSecondsAgo} />
        <span
          className="hide-on-mobile"
          style={{
            color:      palette.textDim,
            fontFamily: "var(--font-mono), monospace",
          }}
        >
          {me.email}
        </span>
        <form action={signOutAction}>
          <button type="submit" style={signOutBtn}>sign out</button>
        </form>
      </div>
    </header>
  );
}

function NavLink({
  href, active, children,
}: { href: string; active: boolean; children: React.ReactNode }): ReactElement {
  return (
    <a
      href={href}
      style={{
        textDecoration: "none",
        color:          active ? palette.text : palette.textDim,
        fontWeight:     active ? 600 : 400,
        borderBottom:   active ? `2px solid ${palette.magenta}` : "2px solid transparent",
        paddingBottom:  3,
        transition:     "color 0.12s ease, border-color 0.12s ease",
      }}
    >
      {children}
    </a>
  );
}

function AgentBadge({
  alive, seen,
}: { alive?: boolean; seen?: number | null }): ReactElement | null {
  if (alive == null) return null;
  const color = alive ? palette.green : palette.textMute;
  const label =
    !alive ? "agent offline"
    : seen == null ? "agent alive"
    : `agent alive · ${seen}s`;
  return (
    <span
      style={{
        display:    "inline-flex",
        alignItems: "center",
        gap:        6,
        padding:    "3px 8px 3px 7px",
        background: alive ? "rgba(124,255,160,0.06)" : "transparent",
        border:     `1px solid ${alive ? "rgba(124,255,160,0.3)" : palette.border}`,
        borderRadius: 999,
        color,
        fontSize:   11,
        letterSpacing: "0.3px",
      }}
    >
      <span
        style={{
          width: 6, height: 6,
          borderRadius: "50%",
          background: color,
          animation: alive ? "live-tick 1.6s ease-in-out infinite" : "none",
          boxShadow: alive ? `0 0 6px ${color}` : "none",
        }}
      />
      {label}
    </span>
  );
}

/** Inline SVG glyph — circle with a centered diamond, mirrors landing favicon. */
function BrandGlyph(): ReactElement {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r="9" stroke={palette.green} strokeWidth="1.2" fill="none" />
      <path
        d="M11 4 L18 11 L11 18 L4 11 Z"
        stroke={palette.magenta}
        strokeWidth="1.2"
        fill="none"
      />
      <circle cx="11" cy="11" r="1.6" fill={palette.green} />
    </svg>
  );
}

const signOutBtn: React.CSSProperties = {
  background:    "none",
  border:        "none",
  cursor:        "pointer",
  color:         palette.textDim,
  fontSize:      "inherit",
  fontFamily:    "inherit",
  padding:       0,
  textDecoration:"underline",
};
