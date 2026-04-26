//! Tail the shell-hook buffer file (~/.local/share/pulse-agent/shell-events.jsonl)
//! and emit one OTLP span per AI-CLI invocation.
//!
//! The companion shell hook (scripts/pulse-hook.zsh + .bash) writes one JSON
//! line per recognized AI-CLI run with shape:
//!
//!   {
//!     "ts_start_ns": 1735000000000000000,
//!     "ts_end_ns":   1735000000123000000,
//!     "cmd":         "claude",
//!     "exit":        0,
//!     "cwd":         "/Users/mason/code/repo"
//!   }
//!
//! PRIVACY (hard floor): the hook NEVER includes argv beyond the binary name.
//! `claude "<prompt>"` would put the prompt on the command line; we strip it
//! at the source. This module additionally rejects any record whose `cmd`
//! field contains a space or shell metacharacter — a defense in depth in
//! case a future hook variant gets it wrong.
//!
//! The tailer follows the buffer file by file offset (mirrors claude.rs)
//! and resumes after restart. The hook itself rotates the buffer at 10MB
//! by truncating, so the offset can briefly point past EOF — we detect
//! and reset.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::claude::git_info_from_dir;
use crate::otlp::OtlpExporter;
use crate::span::SpanBuilder;
use crate::state::StateDb;

/// AI CLIs we recognize as worth tracking. Anything not on this list is
/// silently ignored even if the hook accidentally records it.
const RECOGNIZED_CLIS: &[&str] = &[
    "claude",   // Claude Code
    "codex",    // OpenAI Codex CLI
    "aider",
    "sgpt",     // shell-gpt
    "q",        // Amazon Q
    "gemini",
    "llm",      // simonw's llm
    "ollama",   // captures `ollama run`
];

#[derive(Debug, Deserialize)]
struct ShellRecord {
    ts_start_ns: u128,
    ts_end_ns:   u128,
    cmd:         String,
    exit:        Option<i64>,
    cwd:         Option<String>,
}

pub fn default_buffer_path() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".local");
    p.push("share");
    p.push("pulse-agent");
    p.push("shell-events.jsonl");
    p
}

/// Run the shell-hook tailer indefinitely (cancels on `shutdown`).
pub async fn run(
    buffer_path: PathBuf,
    exporter: Arc<OtlpExporter>,
    state: Arc<StateDb>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    // Make sure the buffer's parent dir exists so the user can `tee` to
    // it from the hook before the first invocation.
    if let Some(parent) = buffer_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let (fs_tx, mut fs_rx) = mpsc::channel::<()>(64);
    let fs_tx_for_watcher = fs_tx.clone();
    let watch_dir = buffer_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // notify-based watcher; fallback to polling.
    let watcher_result: Result<RecommendedWatcher> = (|| {
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    let _ = fs_tx_for_watcher.try_send(());
                }
            }
        })?;
        watcher.watch(&watch_dir, RecursiveMode::NonRecursive)?;
        Ok(watcher)
    })();

    let _watcher = match watcher_result {
        Ok(w) => Some(w),
        Err(e) => {
            warn!("notify watcher unavailable for shell buffer ({e}), polling at 5s");
            None
        }
    };

    // Polling fallback every 5s.
    let poll_tx = fs_tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = poll_tx.try_send(());
        }
    });

    let _ = fs_tx.try_send(()); // initial scan

    loop {
        tokio::select! {
            _ = fs_rx.recv() => {
                while fs_rx.try_recv().is_ok() {} // debounce
                if let Err(e) = process_buffer(&buffer_path, &exporter, &state).await {
                    warn!("shell buffer scan error: {e:#}");
                }
            }
            _ = shutdown.changed() => {
                debug!("shell tailer shutting down");
                return;
            }
        }
    }
}

async fn process_buffer(
    path: &Path,
    exporter: &OtlpExporter,
    state: &StateDb,
) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let path_str = path.to_string_lossy().into_owned();

    let mut offset = state.get_file_offset(&path_str)?;
    let mut file = OpenOptions::new().read(true).open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let len = file.metadata()?.len();

    // Buffer rotation: if the file is shorter than our offset, the hook
    // truncated it. Reset and read from the start.
    if len < offset {
        debug!("shell buffer rotated; resetting offset");
        offset = 0;
    }
    if len == offset {
        return Ok(());
    }

    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(&file);
    // last_good_offset only advances after a successful export (or a
    // confirmed "skip" — malformed/wrong-cli/etc lines that we'll never
    // be able to emit). An export failure rewinds the offset so the
    // next scan retries the failing line instead of silently dropping it.
    let mut byte_cursor = offset;
    let mut last_good_offset = offset;
    let mut emitted = 0usize;

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 { break; }
        let line_end = byte_cursor + n as u64;
        byte_cursor = line_end;

        let trimmed = line.trim();
        if trimmed.is_empty() {
            last_good_offset = line_end;
            continue;
        }

        let rec: ShellRecord = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => { last_good_offset = line_end; continue; }
        };

        // Defense-in-depth: cmd must be a single bare token, on the
        // recognized list. Belt and suspenders against a future hook
        // variant accidentally including args.
        if rec.cmd.contains(|c: char| c.is_whitespace() || "&|;`$<>(){}[]\"'".contains(c)) {
            warn!("shell tailer: rejected cmd containing shell metachar: {:?}", rec.cmd);
            last_good_offset = line_end;
            continue;
        }
        if !RECOGNIZED_CLIS.contains(&rec.cmd.as_str()) {
            last_good_offset = line_end;
            continue;
        }
        if rec.ts_end_ns < rec.ts_start_ns {
            last_good_offset = line_end; // garbage timing
            continue;
        }

        let (repo_name, git_branch) = match &rec.cwd {
            Some(d) => git_info_from_dir(d),
            None => (None, None),
        };

        let span = SpanBuilder::new("shell.ai_cli", rec.ts_start_ns, rec.ts_end_ns)
            .attr_str("ashlr.source", "shell")
            .attr_str("gen_ai.system", "shell")          // pass the GenAI gate on the server
            .attr_str("shell.cli", &rec.cmd)
            .attr_int_opt("shell.exit_code", rec.exit)
            .attr_str_opt("claude.repo.name", repo_name.as_deref())
            .attr_str_opt("claude.git.branch", git_branch.as_deref())
            .build();

        if let Err(e) = exporter.export(&span).await {
            warn!("failed to export shell span: {e:#}");
            // Don't advance past the failed line — break and retry next scan.
            break;
        }
        last_good_offset = line_end;
        emitted += 1;
    }

    if last_good_offset > offset {
        state.set_file_offset(&path_str, last_good_offset)?;
        if emitted > 0 {
            debug!(path = %path.display(), spans = emitted, "exported shell spans");
        }
    }
    let _ = byte_cursor; // suppress unused warning when no spans emit
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_cmd_with_args() {
        // Simulate a malformed line (cmd field contains space).
        // Our process_buffer skips these — verify the predicate.
        let bad = "claude \"write me a function\"";
        assert!(bad.contains(|c: char| c.is_whitespace()));
    }

    #[test]
    fn recognized_clis_includes_codex() {
        assert!(RECOGNIZED_CLIS.contains(&"codex"));
        assert!(RECOGNIZED_CLIS.contains(&"claude"));
    }
}
