/**
 * DELETE /api/project/[id]/repo/[repo_name] — remove a repo from a project.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { removeProjectRepo } from "@/lib/project-db";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; repo_name: string }> },
): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId, repo_name } = await ctx.params;

  const ok = await removeProjectRepo(projectId, decodeURIComponent(repo_name), me.id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
