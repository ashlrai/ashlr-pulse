//! Auto-discover local git repos for inclusion in the agent's config.toml.
//!
//! Heuristic: walk a small set of common dev roots, find every directory
//! that contains a `.git/` subdirectory, dedupe against repos already in
//! config. Bounded depth + skip-list keeps the scan ~instant even on
//! laptops with hundreds of repos.

use std::path::PathBuf;

const DEFAULT_ROOTS: &[&str] = &["~/Desktop", "~/code", "~/projects", "~/src", "~/dev", "~/work"];

const MAX_DEPTH: usize = 3;

/// Skip directories that are commonly under a dev root but aren't user
/// repos (deps trees, virtualenvs, build outputs, etc.).
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".turbo",
    "venv", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache",
    "vendor", ".cargo", ".rustup", "Library", "Applications",
    ".git",  // never recurse into a .git itself
];

#[derive(Debug, Clone)]
pub struct DiscoveredRepo {
    pub path: PathBuf,
    pub repo_name: Option<String>,  // from `git remote get-url origin`, best-effort
}

pub fn discover(already_configured: &[String]) -> Vec<DiscoveredRepo> {
    let already: std::collections::HashSet<PathBuf> = already_configured
        .iter()
        .map(|s| crate::config::expand_tilde(s).canonicalize().unwrap_or_else(|_| PathBuf::from(s)))
        .collect();

    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for root_str in DEFAULT_ROOTS {
        let root = crate::config::expand_tilde(root_str);
        if !root.is_dir() { continue; }
        walk(&root, 0, &mut found, &mut seen);
    }

    // Drop already-configured entries.
    found.retain(|r| {
        let canon = r.path.canonicalize().unwrap_or_else(|_| r.path.clone());
        !already.contains(&canon)
    });
    // Sort newest-modified first so the user sees recently-touched repos
    // at the top of the proposal.
    found.sort_by_key(|r| {
        std::fs::metadata(&r.path).and_then(|m| m.modified()).ok()
    });
    found.reverse();
    found
}

fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<DiscoveredRepo>, seen: &mut std::collections::HashSet<PathBuf>) {
    if depth > MAX_DEPTH { return; }
    let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if !seen.insert(canon.clone()) { return; }

    // Is THIS dir a git repo? Check for .git/
    let dot_git = dir.join(".git");
    if dot_git.exists() {
        out.push(DiscoveredRepo {
            path: dir.to_path_buf(),
            repo_name: derive_repo_name(dir),
        });
        return; // don't recurse into a repo's nested dirs (worktrees, submodules)
    }

    // Otherwise recurse into children.
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() { continue; }
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') && name != ".cargo" { continue; }  // skip dot-dirs
        if SKIP_DIRS.contains(&name) { continue; }
        walk(&p, depth + 1, out, seen);
    }
}

fn derive_repo_name(dir: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["-C", &dir.to_string_lossy(), "remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if url.is_empty() { return None; }
    Some(crate::claude::remote_url_to_repo_name(&url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_dirs_includes_node_modules() {
        assert!(SKIP_DIRS.contains(&"node_modules"));
        assert!(SKIP_DIRS.contains(&"target"));
    }

    #[test]
    fn discover_filters_already_configured() {
        // Smoke test: even if discovery returns nothing we shouldn't panic.
        let _ = discover(&["/nonexistent/path".to_string()]);
    }
}
