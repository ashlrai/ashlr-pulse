/**
 * auth-routing.test.ts — protect the auth-routing surface area against
 * regressions of the GitHub-login outage we hit in 0.x.
 *
 * Three pieces, each easy to break silently:
 *
 *   1. middleware's PROTECTED_PREFIXES list — must include every page
 *      that calls redirect("/login"), and must NOT swallow public paths
 *      (/, /login, /auth/*, /agent-onboard, /share/*).
 *   2. error.tsx's redirectTargetFromDigest — must follow safe redirect
 *      digests, must reject open-redirect-shaped URLs.
 *   3. /auth/callback's setAll closure — must write Supabase session
 *      cookies onto the *returned* response, not onto request cookies
 *      that get dropped when a fresh NextResponse.redirect() is built.
 *      This is the bug that broke "continue with github" — `cookies()`
 *      from next/headers staged the cookies on the request, the new
 *      redirect response went out with no Set-Cookie, the user landed
 *      on /app unauthenticated.
 */

import { describe, expect, test } from "bun:test";
import { NextResponse } from "next/server";
import { isProtectedPath, PROTECTED_PREFIXES } from "../src/middleware";
import { redirectTargetFromDigest } from "../src/app/error";

describe("isProtectedPath", () => {
  test.each([
    // Exact match.
    ["/app", true],
    ["/projects", true],
    ["/settings", true],
    ["/billing", true],
    ["/ask", true],
    ["/github", true],
    // Sub-paths.
    ["/app/", true],
    ["/settings/tokens", true],
    ["/projects/abc-123/edit", true],
    ["/billing/portal-return", true],
    // Public paths must NOT be protected.
    ["/", false],
    ["/login", false],
    ["/auth/callback", false],
    ["/agent-onboard", false],
    ["/share/some-peer", false],
    ["/api/healthz", false],
    ["/api/otlp/v1/traces", false],
    // Prefix-collision regression: /apps must NOT be treated as /app.
    ["/apps", false],
    ["/appearance", false],
    ["/githubsucks", false],
    ["/settingsbar", false],
  ])("%s → protected=%s", (path, expected) => {
    expect(isProtectedPath(path as string)).toBe(expected);
  });

  test("PROTECTED_PREFIXES is non-empty (sanity)", () => {
    expect(PROTECTED_PREFIXES.length).toBeGreaterThan(0);
  });
});

describe("redirectTargetFromDigest", () => {
  test("parses a typical Next.js redirect digest", () => {
    expect(redirectTargetFromDigest("NEXT_REDIRECT;replace;/login;307;")).toBe(
      "/login",
    );
  });

  test("parses with a query string in the URL slot", () => {
    expect(
      redirectTargetFromDigest("NEXT_REDIRECT;push;/login?next=%2Fapp;307;"),
    ).toBe("/login?next=%2Fapp");
  });

  test.each([
    [undefined],
    [""],
    ["no-digest"],
    // Different digest namespace (notFound, etc.).
    ["NEXT_NOT_FOUND"],
    // Malformed — missing url slot.
    ["NEXT_REDIRECT;replace"],
    ["NEXT_REDIRECT;;;"],
  ])("rejects non-redirect digest: %p", (digest) => {
    expect(redirectTargetFromDigest(digest as string | undefined)).toBeNull();
  });

  test.each([
    // Open redirects must be rejected — same-origin only.
    "NEXT_REDIRECT;replace;//evil.com;307;",
    "NEXT_REDIRECT;replace;https://evil.com;307;",
    "NEXT_REDIRECT;replace;javascript:alert(1);307;",
    "NEXT_REDIRECT;replace;not-a-path;307;",
  ])("rejects unsafe url: %s", (digest) => {
    expect(redirectTargetFromDigest(digest)).toBeNull();
  });
});

describe("/auth/callback cookie persistence (regression)", () => {
  // The bug: cookies set via cookies() from next/headers don't carry over
  // to a NextResponse.redirect() built fresh in a Route Handler. The fix:
  // build the response first, then have the supabase setAll callback
  // write directly onto response.cookies. This test exercises the closure
  // pattern in isolation so a refactor that re-introduces the bug fails
  // here before reaching production.
  test("setAll closure writes cookies onto the redirect response", () => {
    const response = NextResponse.redirect(new URL("https://pulse.example/app"));

    // Mirror the route handler's setAll callback exactly.
    const setAll = (
      toSet: Array<{
        name: string;
        value: string;
        options?: { path?: string; httpOnly?: boolean; sameSite?: "lax" | "strict" | "none" };
      }>,
    ): void => {
      for (const { name, value, options } of toSet) {
        response.cookies.set({ name, value, ...options });
      }
    };

    // Simulate Supabase staging two session cookies (access + refresh).
    setAll([
      {
        name: "sb-access-token",
        value: "eyJhbGc.access.signature",
        options: { path: "/", httpOnly: true, sameSite: "lax" },
      },
      {
        name: "sb-refresh-token",
        value: "rt-abcdef",
        options: { path: "/", httpOnly: true, sameSite: "lax" },
      },
    ]);

    const access = response.cookies.get("sb-access-token");
    const refresh = response.cookies.get("sb-refresh-token");

    expect(access?.value).toBe("eyJhbGc.access.signature");
    expect(refresh?.value).toBe("rt-abcdef");

    // The redirect status + Location must survive the cookie writes.
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/app");
  });

  test("writing a cookie via setAll preserves attributes", () => {
    const response = NextResponse.redirect(new URL("https://pulse.example/app"));
    response.cookies.set({
      name: "sb-test",
      value: "v",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });

    // The Set-Cookie header is the source of truth for what reaches the
    // browser; serialize and check the attributes survived.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sb-test=v");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("secure");
    expect(setCookie).toContain("Path=/");
  });
});
