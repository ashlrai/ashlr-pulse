/**
 * DELETE /api/pat/[id] — soft-revoke a PAT the caller owns.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { revokePat } from "@/lib/pat";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const ok = await revokePat(id, me.id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
