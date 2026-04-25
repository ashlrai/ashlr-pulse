"use client";

/**
 * error.tsx — global error boundary.
 *
 * Renders a friendly message without exposing raw error.message (which can
 * contain stack frames or prompt content). Pings /api/_log/error with the
 * Next.js digest so the error appears in server logs.
 *
 * Next.js automatically wraps the page tree in this boundary when it catches
 * an unhandled error during render.
 */

import { useEffect } from "react";
import type { ReactElement } from "react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps): ReactElement {
  useEffect(() => {
    // Ping the server log endpoint with the digest (never the raw message).
    void fetch("/api/_log/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digest: error.digest ?? "no-digest" }),
    }).catch(() => {
      // Best-effort; if logging fails we don't want to recurse.
    });
  }, [error]);

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 32,
        maxWidth: 600,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22 }}>something broke.</h1>
      <p style={{ marginTop: 12, color: "#666" }}>
        we logged it. try again or{" "}
        <a href="/" style={{ color: "#444" }}>head home</a>.
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 16,
          padding: "10px 16px",
          fontSize: 13,
          fontFamily: "inherit",
          background: "#111",
          color: "#fff",
          border: 0,
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        try again
      </button>
    </main>
  );
}
