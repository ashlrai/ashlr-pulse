/**
 * /api/github/oauth/callback — exchange code for access_token, persist.
 *
 * Validates the CSRF state cookie, swaps the GitHub `code` for an access
 * token, fetches the user identity, encrypts + upserts into github_account.
 * Redirects to /github (the connected-account page) on success.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { upsertAccount } from "@/lib/github-account-db";
import { GitHubClient } from "@/lib/github-client";

export const runtime = "nodejs";

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export async function GET(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("pulse_gh_state="))
    ?.slice("pulse_gh_state=".length);

  if (!code || !state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(
      new URL("/github?error=invalid+oauth+state", req.url),
    );
  }
  // State format: "<user_id>:<random>" — verify the prefix matches the
  // current session's user so a stolen state can't be replayed cross-account.
  if (!state.startsWith(`${me.id}:`)) {
    return NextResponse.redirect(
      new URL("/github?error=state+user+mismatch", req.url),
    );
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL("/github?error=oauth+not+configured", req.url),
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${appUrl}/api/github/oauth/callback`,
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      new URL("/github?error=token+exchange+failed", req.url),
    );
  }

  const body = (await tokenRes.json()) as AccessTokenResponse;
  if (!body.access_token) {
    const err = encodeURIComponent(body.error_description ?? body.error ?? "unknown");
    return NextResponse.redirect(new URL(`/github?error=${err}`, req.url));
  }

  const gh = new GitHubClient(body.access_token);
  const me_gh = await gh.me();

  await upsertAccount({
    user_id: me.id,
    github_user_id: me_gh.id,
    github_login: me_gh.login,
    avatar_url: me_gh.avatar_url ?? null,
    scopes: (body.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    access_token: body.access_token,
  });

  const res = NextResponse.redirect(new URL("/github?ok=1", req.url));
  // Clean up the state cookie.
  res.cookies.set("pulse_gh_state", "", { path: "/", maxAge: 0 });
  return res;
}
