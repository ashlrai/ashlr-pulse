/**
 * /login — magic-link sign-in.
 *
 * Founding-pair scope: no password flow, no OAuth providers. One email
 * field, one button, magic link in inbox. Adding OAuth (GitHub) is a
 * v0.4 task when we open up to outside teams.
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { server } from "@/lib/supabase-server";

async function sendMagicLink(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return;

  const supabase = await server();
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect("/login?sent=1");
}

interface SearchParams {
  sent?: string;
  error?: string;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const { sent, error } = await searchParams;
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 32,
        maxWidth: 480,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 24 }}>Pulse · sign in</h1>
      <p style={{ color: "#666", marginTop: 4 }}>magic link, no password</p>

      <form action={sendMagicLink} style={{ marginTop: 32 }}>
        <input
          type="email"
          name="email"
          placeholder="you@yourcompany.com"
          required
          autoFocus
          style={{
            width: "100%",
            padding: 12,
            fontSize: 14,
            fontFamily: "inherit",
            border: "1px solid #ccc",
            borderRadius: 4,
          }}
        />
        <button
          type="submit"
          style={{
            marginTop: 12,
            padding: "12px 16px",
            fontSize: 14,
            fontFamily: "inherit",
            background: "#111",
            color: "#fff",
            border: 0,
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          send link
        </button>
      </form>

      {sent && (
        <p style={{ marginTop: 16, color: "#080" }}>
          check your email — link is good for one hour.
        </p>
      )}
      {error && (
        <p style={{ marginTop: 16, color: "#c00" }}>error: {error}</p>
      )}
    </main>
  );
}
