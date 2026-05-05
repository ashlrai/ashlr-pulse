/**
 * /api/dashboard-views
 *
 * GET    → list the current user's saved views
 * POST   → create a saved view from { name, filter }
 * DELETE → ?id=<uuid> remove one
 *
 * All three require a logged-in user; we never accept a user_id in the
 * request body. The route is a thin wrapper around dashboard-view-db.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { listViews, createView, deleteView } from "@/lib/dashboard-view-db";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const views = await listViews(me.id);
  return NextResponse.json({ views });
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
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const view = await createView(me.id, name, obj.filter);
  if (!view) return NextResponse.json({ error: "name conflict or invalid filter" }, { status: 409 });
  return NextResponse.json({ view });
}

export async function DELETE(req: Request): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await deleteView(me.id, id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
