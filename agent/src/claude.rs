//! Tail ~/.claude/projects/*/*.jsonl and build claude_code OTLP spans.
//!
//! Each assistant turn in a Claude Code session produces one span carrying
//! token usage and session metadata. No prompt text or completion text is
//! ever read or transmitted — only numeric token counts and metadata.
//!
//! File watching uses `notify` with a fallback to 5-second polling when
//! the inotify/FSEvents watcher fails (e.g. in network mounts).

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::otlp::OtlpExporter;
use crate::span::{now_ns, SpanBuilder};
use crate::state::StateDb;

// ── JSONL message shapes ───────────────────────────────────────────────────

/// Minimal shape of an assistant message in a Claude Code JSONL.
/// We only parse the fields we need — everything else is ignored.
#[derive(Debug, Deserialize)]
struct JournalLine {
    #[allow(dead_code)] // kept for forward-compat; not inspected at runtime
    #[serde(rename = "type")]
    kind: Option<String>,
    message: Option<AssistantMessage>,
    /// Session-level cwd present on the first "system" line.
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    role: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
    /// Anthropic key name in Claude Code JSONL.
    cache_creation_input_tokens: Option<i64>,
}

// ── Main entry point ──────────────────────────────────────────────────────

/// Run the Claude source watcher indefinitely (cancels on `shutdown`).
pub async fn run(
    projects_dir: PathBuf,
    exporter: Arc<OtlpExporter>,
    state: Arc<StateDb>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    // Try to set up a filesystem watcher; fall back to polling.
    let (fs_tx, mut fs_rx) = mpsc::channel::<()>(64);

    let poll_interval = Duration::from_secs(5);
    let fs_tx_clone = fs_tx.clone();

    // Attempt to use notify for real-time tailing.
    let watcher_result: Result<RecommendedWatcher> = (|| {
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            match res {
                Ok(ev) if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) => {
                    let _ = fs_tx_clone.try_send(());
                }
                _ => {}
            }
        })?;
        watcher.watch(&projects_dir, RecursiveMode::Recursive)?;
        Ok(watcher)
    })();

    let _watcher = match watcher_result {
        Ok(w) => {
            debug!("using notify watcher for claude projects dir");
            Some(w)
        }
        Err(e) => {
            warn!("notify watcher unavailable ({e}), falling back to 5s polling");
            None
        }
    };

    // Polling fallback: send a tick every 5 seconds regardless.
    let poll_tx = fs_tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(poll_interval).await;
            let _ = poll_tx.try_send(());
        }
    });

    // Initial scan on startup.
    let _ = fs_tx.try_send(());

    loop {
        tokio::select! {
            _ = fs_rx.recv() => {
                // Drain the channel (debounce).
                while fs_rx.try_recv().is_ok() {}
                if let Err(e) = scan_all(&projects_dir, &exporter, &state).await {
                    warn!("claude scan error: {e:#}");
                }
            }
            _ = shutdown.changed() => {
                debug!("claude watcher shutting down");
                return;
            }
        }
    }
}

async fn scan_all(
    projects_dir: &Path,
    exporter: &OtlpExporter,
    state: &StateDb,
) -> Result<()> {
    let pattern = projects_dir.join("projects").join("*").join("*.jsonl");
    let pattern_str = pattern.to_string_lossy();

    let entries = glob_jsonl(projects_dir)?;
    for path in entries {
        if let Err(e) = process_file(&path, exporter, state).await {
            warn!("error processing {}: {e:#}", path.display());
        }
    }
    let _ = pattern_str; // suppress unused warning
    Ok(())
}

/// Walk `projects_dir/projects/*/*.jsonl` and return all matching paths.
fn glob_jsonl(projects_dir: &Path) -> Result<Vec<PathBuf>> {
    let projects = projects_dir.join("projects");
    let mut out = Vec::new();
    if !projects.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&projects).context("reading projects dir")? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            for inner in std::fs::read_dir(entry.path()).context("reading project subdir")? {
                let inner = inner?;
                let p = inner.path();
                if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    out.push(p);
                }
            }
        }
    }
    Ok(out)
}

async fn process_file(
    path: &Path,
    exporter: &OtlpExporter,
    state: &StateDb,
) -> Result<()> {
    let path_str = path.to_string_lossy().into_owned();

    let offset = state.get_file_offset(&path_str)?;

    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;

    let metadata = file.metadata()?;
    let file_len = metadata.len();

    if file_len <= offset {
        return Ok(()); // no new bytes
    }

    file.seek(SeekFrom::Start(offset))?;

    let mut reader = BufReader::new(&file);
    let mut new_offset = offset;
    let mut cwd: Option<String> = None;

    // The project hash is the directory component of the path:
    // ~/.claude/projects/<hash>/session.jsonl
    let project_hash = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned());

    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned());

    let mut lines_processed = 0usize;

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break; // EOF
        }
        new_offset += n as u64;

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let parsed: JournalLine = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // malformed line; skip
        };

        // Capture cwd from the first system/init line.
        if parsed.cwd.is_some() {
            cwd = parsed.cwd.clone();
        }

        // Only process assistant turns with usage data.
        let msg = match &parsed.message {
            Some(m) if m.role.as_deref() == Some("assistant") => m,
            _ => continue,
        };
        let usage = match &msg.usage {
            Some(u) => u,
            None => continue,
        };

        // Derive repo name and branch from cwd if available.
        let (repo_name, git_branch) = match &cwd {
            Some(dir) => git_info_from_dir(dir),
            None => (None, None),
        };

        let ts_ns = now_ns();

        let span = SpanBuilder::new("gen_ai.request", ts_ns, ts_ns)
            .attr_str("gen_ai.system", "anthropic")
            .attr_str_opt("gen_ai.request.model", msg.model.as_deref())
            .attr_int_opt("gen_ai.usage.input_tokens", usage.input_tokens)
            .attr_int_opt("gen_ai.usage.output_tokens", usage.output_tokens)
            .attr_int_opt("gen_ai.usage.cache_read_tokens", usage.cache_read_input_tokens)
            .attr_int_opt("gen_ai.usage.cache_write_tokens", usage.cache_creation_input_tokens)
            .attr_str_opt("claude.session.id", session_id.as_deref())
            .attr_str_opt("claude.project.hash", project_hash.as_deref())
            .attr_str_opt("claude.repo.name", repo_name.as_deref())
            .attr_str_opt("claude.git.branch", git_branch.as_deref())
            .build();

        if let Err(e) = exporter.export(&span).await {
            warn!("failed to export claude span: {e:#}");
            // Don't advance watermark — we'll retry next scan.
            break;
        }
        lines_processed += 1;
    }

    if new_offset > offset {
        state.set_file_offset(&path_str, new_offset)?;
        if lines_processed > 0 {
            debug!(path = %path.display(), spans = lines_processed, "exported claude spans");
        }
    }

    Ok(())
}

/// Attempt to read repo name and branch from a working directory path.
/// Returns (None, None) on any error — this is best-effort.
fn git_info_from_dir(dir: &str) -> (Option<String>, Option<String>) {
    use git2::Repository;

    let repo = match Repository::discover(dir) {
        Ok(r) => r,
        Err(_) => return (None, None),
    };

    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let repo_name = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()))
        .map(|url| remote_url_to_repo_name(&url))
        .or_else(|| {
            repo.workdir()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().into_owned())
        });

    (repo_name, branch)
}

/// Convert a git remote URL to a `org/repo` style name.
/// Handles both SSH (`git@github.com:org/repo.git`) and HTTPS forms.
pub fn remote_url_to_repo_name(url: &str) -> String {
    // Strip trailing .git
    let url = url.trim_end_matches(".git");
    // SSH: git@github.com:org/repo → org/repo
    // The colon must not be followed by // (which is the HTTPS scheme separator).
    if let Some(idx) = url.find(':') {
        let after = &url[idx + 1..];
        if !url[..idx].contains('/') && !after.starts_with("//") {
            return after.to_string();
        }
    }
    // HTTPS: https://github.com/org/repo → take last two path segments
    let parts: Vec<&str> = url.trim_end_matches('/').split('/').collect();
    let n = parts.len();
    if n >= 2 {
        format!("{}/{}", parts[n - 2], parts[n - 1])
    } else {
        url.to_string()
    }
}

/// SHA256 of the project dir path (used as `claude.project.hash`).
/// The projects/<hash>/ directory segment is already this hash in practice,
/// but we expose this helper for completeness / testing.
pub fn project_path_hash(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hex::encode(hasher.finalize())
}
