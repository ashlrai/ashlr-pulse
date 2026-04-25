/**
 * POST /api/project/[id]/repo — add a repo to a project.
 */

import { NextResponse } from "next/server";
import { currentUser } from "@/lib/current-user";
import { addProjectRepo } from "@/lib/project-db";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const repo_name = typeof b.repo_name === "string" ? b.repo_name.trim() : "";
  if (!repo_name) return NextResponse.json({ error: "repo_name is required" }, { status: 400 });

  const ok = await addProjectRepo(projectId, repo_name, me.id);
  if (!ok) return NextResponse.json({ error: "project not found or not authorized" }, { status: 404 });

  return NextResponse.json({ project_id: projectId, repo_name }, { status: 201 });
}
