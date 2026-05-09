/**
 * /api/pat — list (GET) + create (POST) personal access tokens.
 *
 * Auth: cookie session only. PATs are ingest-only and cannot bootstrap
 * themselves — you must be signed in to manage them.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { mintPat, listPats, normalizePatScopes } from "@/lib/pat";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pats = await listPats(me.id);
  return NextResponse.json(pats);
}

export async function POST(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const name =
    body && typeof body === "object" && "name" in body && typeof (body as Record<string, unknown>).name === "string"
      ? ((body as Record<string, unknown>).name as string).trim()
      : "";

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const rawScopes =
    body && typeof body === "object" && "scopes" in body && Array.isArray((body as Record<string, unknown>).scopes)
      ? ((body as Record<string, unknown>).scopes as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined;
  let scopes: ReturnType<typeof normalizePatScopes>;
  try {
    scopes = normalizePatScopes(rawScopes);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid scopes" },
      { status: 400 },
    );
  }

  const minted = await mintPat(me.id, name, scopes);
  return NextResponse.json({ id: minted.id, token: minted.token, name, scopes }, { status: 201 });
}
