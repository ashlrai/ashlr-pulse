import type { ReactElement, ReactNode } from "react";

export const metadata = {
  title: "Ashlr Pulse",
  description: "Shared heartbeat for agentic-engineering teams.",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
