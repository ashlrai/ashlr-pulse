/**
 * /api/github/oauth/start — kicks off GitHub OAuth flow.
 *
 * We don't use Supabase's "Sign in with GitHub" provider because we need
 * the access token retained server-side for repo data ingest (Supabase's
 * provider flow doesn't expose the upstream token to our DB). Instead we
 * run our own OAuth code-flow against GitHub:
 *
 *   1. user clicks "Connect GitHub" → /api/github/oauth/start
 *   2. we redirect them to github.com/login/oauth/authorize?...
 *   3. GitHub redirects back to /api/github/oauth/callback?code=...
 *   4. callback exchanges code for access_token, persists encrypted, redirects to /github
 *
 * Required env:
 *   GITHUB_OAUTH_CLIENT_ID
 *   GITHUB_OAUTH_CLIENT_SECRET
 *   NEXT_PUBLIC_APP_URL  (used to build the absolute callback URL)
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { randomBytes } from "crypto";

export const runtime = "nodejs";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";

const SCOPES = [
  "read:user",        // for /user (login + id)
  "repo",             // for private repo access (commits + PRs)
  "read:org",         // for org-owned repos
].join(" ");

export async function GET(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.redirect(new URL("/login?next=/github", req.url));
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GITHUB_OAUTH_CLIENT_ID not configured" },
      { status: 500 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const redirectUri = `${appUrl}/api/github/oauth/callback`;

  // CSRF state — random + tied to the user's id. We verify on callback.
  const state = `${me.id}:${randomBytes(16).toString("hex")}`;

  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  // Always prompt — lets the user see what we're requesting + change accounts.
  url.searchParams.set("allow_signup", "false");

  const res = NextResponse.redirect(url);
  // Store the state in a cookie so callback can verify (5-minute window).
  res.cookies.set("pulse_gh_state", state, {
    httpOnly: true,
    secure: appUrl.startsWith("https://"),
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });
  return res;
}
