/**
 * /projects — list + create projects, manage repos per project.
 *
 * First project create auto-creates a default org (slug = email local part).
 */

import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/current-user";
import { ensureDefaultOrg } from "@/lib/current-user";
import { listProjects, createProject, addProjectRepo, removeProjectRepo } from "@/lib/project-db";
import { Header } from "@/components/Header";

export const dynamic = "force-dynamic";

const VALID_KINDS = ["saas", "client", "internal", "experiment"] as const;
type ProjectKind = typeof VALID_KINDS[number];

async function createProjectAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "internal") as ProjectKind;
  if (!name) redirect("/projects?error=name+required");
  if (!VALID_KINDS.includes(kind)) redirect("/projects?error=invalid+kind");

  const orgId = await ensureDefaultOrg(me.id, me.email);
  try {
    await createProject({ org_id: orgId, name, kind });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    redirect(`/projects?error=${encodeURIComponent(m)}`);
  }
  revalidatePath("/projects");
  redirect("/projects?ok=created");
}

async function addRepoAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const projectId = String(formData.get("project_id") ?? "");
  const repoName = String(formData.get("repo_name") ?? "").trim();
  if (!projectId || !repoName) return;
  await addProjectRepo(projectId, repoName, me.id);
  revalidatePath("/projects");
}

async function removeRepoAction(formData: FormData): Promise<void> {
  "use server";
  const me = await currentUser();
  if (!me) redirect("/login");
  const projectId = String(formData.get("project_id") ?? "");
  const repoName = String(formData.get("repo_name") ?? "");
  if (!projectId || !repoName) return;
  await removeProjectRepo(projectId, repoName, me.id);
  revalidatePath("/projects");
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}): Promise<ReactElement> {
  const me = await currentUser();
  if (!me) redirect("/login");

  const projects = await listProjects(me.id);
  const { ok, error } = await searchParams;

  return (
    <main style={{ padding: "0 32px 32px", maxWidth: 900, margin: "0 auto" }}>
      <Header me={me} active="projects" />
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.5px" }}>projects</h1>
      <p style={{ color: "#666", marginTop: 4, fontSize: 13 }}>
        group repos into SaaS / client / internal / experiment buckets so the dashboard rolls up by line of work.
      </p>

      {ok && <p style={{ color: "#080" }}>project created.</p>}
      {error && <p style={{ color: "#c00" }}>error: {error}</p>}

      <h2 style={{ fontSize: 16, marginTop: 32 }}>new project</h2>
      <form action={createProjectAction} style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 580 }}>
        <label style={{ flex: 2 }}>
          name
          <input name="name" type="text" required placeholder="my-saas" style={inp} />
        </label>
        <label style={{ flex: 1 }}>
          kind
          <select name="kind" defaultValue="internal" style={inp}>
            {VALID_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <button type="submit" style={btn}>create</button>
      </form>

      <h2 style={{ fontSize: 16, marginTop: 32 }}>your projects</h2>
      {projects.length === 0 ? (
        <p style={{ color: "#888" }}>no projects yet.</p>
      ) : (
        projects.map((p) => (
          <div key={p.id} style={{ marginTop: 20, padding: 16, border: "1px solid #ddd", borderRadius: 4 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{p.name} <span style={{ color: "#888", fontWeight: 400, fontSize: 12 }}>({p.kind})</span></p>
            <p style={{ margin: "4px 0 8px", fontSize: 12, color: "#888" }}>id: {p.id}</p>

            {/* repo list */}
            {p.repos.length > 0 && (
              <ul style={{ margin: "0 0 8px", paddingLeft: 16 }}>
                {p.repos.map((r) => (
                  <li key={r} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <code>{r}</code>
                    <form action={removeRepoAction} style={{ display: "inline" }}>
                      <input type="hidden" name="project_id" value={p.id} />
                      <input type="hidden" name="repo_name" value={r} />
                      <button type="submit" style={revokeBtn}>remove</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {/* add repo */}
            <form action={addRepoAction} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <input type="hidden" name="project_id" value={p.id} />
              <input name="repo_name" type="text" placeholder="owner/repo" style={{ ...inp, marginTop: 0, width: 220 }} />
              <button type="submit" style={{ ...btn, padding: "8px 12px", fontSize: 12 }}>add repo</button>
            </form>
          </div>
        ))
      )}
    </main>
  );
}

const inp: React.CSSProperties = { display: "block", width: "100%", padding: 8, fontSize: 13, fontFamily: "inherit", border: "1px solid #ccc", borderRadius: 4, marginTop: 4 };
const btn: React.CSSProperties = { padding: "10px 14px", fontSize: 13, fontFamily: "inherit", background: "#111", color: "#fff", border: 0, borderRadius: 4, cursor: "pointer" };
const revokeBtn: React.CSSProperties = { padding: "2px 6px", fontSize: 11, background: "transparent", color: "#c00", border: "1px solid #c00", borderRadius: 3, cursor: "pointer" };
