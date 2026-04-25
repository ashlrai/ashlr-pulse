/**
 * DELETE /api/peer-share/[id] — soft-revoke a grant the caller owns.
 *
 * Returns 204 on success, 404 if the grant doesn't exist or the caller
 * doesn't own it (deliberately conflated to avoid leaking IDs).
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { revokeShare } from "@/lib/peer-share-db";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const ok = await revokeShare(id, me.id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
