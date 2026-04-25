/**
 * Header.tsx — shared top nav for authenticated pages.
 *
 * Server component (zero client JS). Reads the current user from the
 * session via lib/current-user; renders only on pages that already
 * required auth, so it never has to handle the unauth case.
 */

import type { ReactElement } from "react";
import { signOutAction } from "@/lib/auth-actions";
import type { CurrentUser } from "@/lib/current-user";

interface Props {
  me: CurrentUser;
  active: "dashboard" | "github" | "share" | "projects" | "tokens";
}

export function Header({ me, active }: Props): ReactElement {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "16px 0",
        borderBottom: "1px solid #ececec",
        marginBottom: 32,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <a href="/" style={{ ...brand, textDecoration: "none", color: "#111" }}>
          Pulse
        </a>
        <nav style={{ display: "flex", gap: 16, fontSize: 13 }}>
          <NavLink href="/" active={active === "dashboard"}>dashboard</NavLink>
          <NavLink href="/github" active={active === "github"}>github</NavLink>
          <NavLink href="/projects" active={active === "projects"}>projects</NavLink>
          <NavLink href="/share" active={active === "share"}>sharing</NavLink>
          <NavLink href="/settings/tokens" active={active === "tokens"}>tokens</NavLink>
        </nav>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "#666" }}>
        <code>{me.email}</code>
        <form action={signOutAction}>
          <button type="submit" style={signOutBtn}>sign out</button>
        </form>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}): ReactElement {
  return (
    <a
      href={href}
      style={{
        textDecoration: "none",
        color: active ? "#111" : "#666",
        fontWeight: active ? 600 : 400,
        borderBottom: active ? "2px solid #111" : "2px solid transparent",
        paddingBottom: 2,
      }}
    >
      {children}
    </a>
  );
}

const brand: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  letterSpacing: "-0.5px",
};

const signOutBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#666",
  fontSize: "inherit",
  padding: 0,
  textDecoration: "underline",
};
