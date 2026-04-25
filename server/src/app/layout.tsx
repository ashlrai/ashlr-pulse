import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

export const metadata: Metadata = {
  title: "Pulse · Ashlr",
  description: "Shared mission control for agentic-engineering teams.",
};

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
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
          a { color: #0369a1; text-decoration: none; }
          a:hover { text-decoration: underline; }
          code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: #f6f6f6; padding: 1px 5px; border-radius: 3px; }
          button { font-family: inherit; }
          table { border-collapse: collapse; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
