/**
 * not-found.tsx — friendly 404 page.
 */

import type { ReactElement } from "react";

export default function NotFound(): ReactElement {
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 32,
        maxWidth: 600,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22 }}>404 — not found.</h1>
      <p style={{ marginTop: 12, color: "#666" }}>
        that page doesn't exist.{" "}
        <a href="/" style={{ color: "#444" }}>head home →</a>
      </p>
    </main>
  );
}
