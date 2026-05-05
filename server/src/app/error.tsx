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
 *
 * Redirect-digest fallback: when a server component throws `redirect(url)`
 * inside a streamed (Suspense-bearing) tree on a hard page load, Next.js
 * cannot convert it to a 307 — the digest arrives client-side and would
 * otherwise render this boundary instead of navigating. Middleware handles
 * the auth-gate cases (where this is most likely to matter), but we treat
 * the digest as a navigation here too, defensively, so any future redirect
 * doesn't surface as "something broke".
 */

import { useEffect } from "react";
import type { ReactElement } from "react";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Parse a NEXT_REDIRECT digest like "NEXT_REDIRECT;replace;/login;307;"
 * into the destination URL. Returns null when not a redirect digest or
 * the URL slot is missing/unsafe (must start with "/" — same-origin only).
 *
 * Exported for tests; not used outside this module.
 */
export function redirectTargetFromDigest(digest: string | undefined): string | null {
  if (!digest || !digest.startsWith("NEXT_REDIRECT")) return null;
  const parts = digest.split(";");
  // Layout: NEXT_REDIRECT ; <kind: replace|push> ; <url> ; <status?> ;
  const url = parts[2];
  if (!url || !url.startsWith("/") || url.startsWith("//")) return null;
  return url;
}

export default function ErrorPage({ error, reset }: ErrorPageProps): ReactElement {
  const redirectTo = redirectTargetFromDigest(error.digest);

  useEffect(() => {
    if (redirectTo) {
      // Use replace() so the broken /app entry doesn't pollute history.
      window.location.replace(redirectTo);
      return;
    }
    // Ping the server log endpoint with the digest (never the raw message).
    void fetch("/api/_log/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digest: error.digest ?? "no-digest" }),
    }).catch(() => {
      // Best-effort; if logging fails we don't want to recurse.
    });
  }, [error, redirectTo]);

  if (redirectTo) {
    // Render nothing visible while window.location.replace() is in flight —
    // a flash of "something broke" before navigating is worse than blank.
    return <></>;
  }

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
