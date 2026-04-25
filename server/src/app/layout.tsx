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
          code { font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: #f6f6f6; padding: 1px 5px; border-radius: 3px; }
          button { font-family: inherit; }
          table { border-collapse: collapse; }
          ::selection { background: rgba(124,255,160,0.35); color: inherit; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
