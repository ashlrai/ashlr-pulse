import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import type { ReactElement, ReactNode } from "react";

export const metadata: Metadata = {
  title: "Pulse · Ashlr",
  description: "Shared mission control for agentic-engineering teams.",
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
