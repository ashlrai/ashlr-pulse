import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import type { ReactElement, ReactNode } from "react";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://pulse.ashlr.ai"),
  title: {
    default: "Pulse · shared mission control for agentic-engineering teams",
    template: "%s · Pulse",
  },
  description:
    "Cofounder-scale visibility across every repo and AI tool. Configurable peer-share. Hard privacy floor — Pulse never stores prompts, completions, or code.",
  applicationName: "Pulse",
  authors: [{ name: "Ashlr AI", url: "https://ashlr.ai" }],
  keywords: [
    "agentic engineering", "AI dev tools", "peer visibility",
    "OpenTelemetry GenAI", "Claude Code observability", "cofounder dashboard",
  ],
  openGraph: {
    type: "website",
    siteName: "Pulse",
    title: "Pulse · shared mission control for agentic-engineering teams",
    description:
      "Cofounder-scale visibility across every repo and AI tool. Configurable peer-share. Hard privacy floor.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pulse · shared mission control for agentic-engineering teams",
    description:
      "Cofounder-scale visibility across every repo and AI tool. Configurable peer-share. Hard privacy floor.",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

const jbm = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en" className={jbm.variable}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <style>{`
          * { box-sizing: border-box; }
          html, body {
            margin: 0; padding: 0;
            font-family: ${FONT_STACK};
            color: #111;
            background: #fff;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }
          a { color: inherit; text-decoration: none; }
          a:hover { text-decoration: underline; }
          /* Default code styling — transparent so it inherits the surrounding
             theme. Dashboard pages render on a dark background; the prior
             #f6f6f6 fill made repo names render as white-on-white in
             /projects > Unassigned Repos. Pages that want a chip-style
             background set it inline. */
          code { font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: transparent; color: inherit; padding: 0; border-radius: 3px; }
          button { font-family: inherit; }
          table { border-collapse: collapse; }
          ::selection { background: rgba(124,255,160,0.35); color: inherit; }

          /* Skeleton pulse — used on dashboard suspense boundaries. */
          @keyframes pulse-skeleton {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
          /* Live-tick — for the heartbeat/agent badge. */
          @keyframes live-tick {
            0%, 60%, 100% { opacity: 1; }
            30%           { opacity: 0.35; }
          }
          /* Subtle fade-in for entrance animations on server-rendered pages. */
          @keyframes fade-in-up {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
          /* Scrollbar — match the dark canvas. */
          *::-webkit-scrollbar { width: 10px; height: 10px; }
          *::-webkit-scrollbar-track { background: #0a0a0a; }
          *::-webkit-scrollbar-thumb { background: #1f1f22; border-radius: 4px; }
          *::-webkit-scrollbar-thumb:hover { background: #2a2a2f; }

          /* Dashboard responsive grid — used by /app and any 2-column section. */
          .dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
          .dash-grid-full { grid-column: 1 / -1; }
          .dash-stat-strip {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
            gap: 12px;
          }
          .dash-shell-pad { padding: 24px 24px 64px; }

          /* Tablet — single-column charts but keep the stat strip wrapping. */
          @media (max-width: 920px) {
            .dash-grid { grid-template-columns: 1fr; }
            .dash-shell-pad { padding: 16px 16px 48px; }
          }

          /* Phone — stat strip stacks at 2 across when possible, then 1. */
          @media (max-width: 560px) {
            .dash-stat-strip { grid-template-columns: 1fr 1fr; gap: 8px; }
            .dash-shell-pad { padding: 12px 12px 40px; }
          }
          @media (max-width: 380px) {
            .dash-stat-strip { grid-template-columns: 1fr; }
          }

          /* Tables on phone: let users swipe horizontally rather than wrap. */
          .scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }

          /* Header email + secondary chrome — hide below 720px so the
             agent badge + sign-out don't wrap. */
          @media (max-width: 720px) {
            .hide-on-mobile { display: none; }
          }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
