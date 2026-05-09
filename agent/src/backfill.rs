//! Backfill: replay every Claude session JSONL from a chosen point in
//! time, ignoring the per-file offset watermark. Useful when you start
//! using Pulse mid-day, install on a fresh machine, or want to verify
//! the last week of activity without restarting the live agent.
//!
//! Idempotent on the server side: migration 0007 added a partial unique
//! index on (user_id, span_id), and the OTLP route does ON CONFLICT DO
//! NOTHING. Re-emitting spans that were already ingested is a no-op.
//!
//! We deliberately DO NOT touch the per-file offset state: the user can
//! kick off `pulse-agent backfill` while `pulse-agent run` is in another
//! terminal and they won't interfere with each other.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use tracing::{info, warn};

use crate::claude::{git_info_from_dir, parse_iso8601_to_ns};
use crate::codex;
use crate::config::Config;
use crate::otlp::OtlpExporter;
use crate::span::{now_ns, SpanBuilder};

/// Subset of JournalLine we need; mirrors claude.rs but kept local so
/// future divergence between live + backfill paths doesn't break either.
#[derive(Debug, Deserialize)]
struct Line {
    message: Option<Msg>,
    cwd: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Msg {
    role: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
    cache_creation_input_tokens: Option<i64>,
}

pub async fn run(since_arg: &str, cfg: &Config, exporter: Arc<OtlpExporter>) -> Result<()> {
    let cutoff_ns = parse_since(since_arg)?;
    let cutoff_human = since_arg;
    info!(cutoff_ns, cutoff_human, "backfill starting");

    let projects = cfg.claude_projects_dir().join("projects");
    let codex_sessions = cfg.codex_sessions_dir();
    if !projects.exists() && !codex_sessions.exists() {
        bail!(
            "no source dirs found — neither {} nor {} exists",
            projects.display(),
            codex_sessions.display(),
        );
    }

    let mut total_seen = 0usize;
    let mut total_emitted = 0usize;
    let mut total_skipped_old = 0usize;
    let mut total_failed = 0usize;
    let mut total_codex_seen = 0usize;
    let mut total_codex_emitted = 0usize;
    let mut total_codex_skipped_old = 0usize;
    let mut total_codex_failed = 0usize;

    if !projects.exists() {
        info!("skipping claude backfill: {} does not exist", projects.display());
    }

    for path in if projects.exists() { walk_jsonl(&projects)? } else { Vec::new() } {
        // Skip files whose mtime is before the cutoff entirely — there
        // can't be any in-window lines in them.
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(mtime) = meta.modified() {
                let mtime_ns = mtime
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                if mtime_ns < cutoff_ns {
                    continue;
                }
            }
        }

        match process_one(&path, cutoff_ns, &exporter).await {
            Ok((seen, emitted, old)) => {
                total_seen      += seen;
                total_emitted   += emitted;
                total_skipped_old += old;
            }
            Err(e) => {
                total_failed += 1;
                warn!("backfill: {} failed: {e:#}", path.display());
            }
        }
    }

    // ── Codex rollout backfill ─────────────────────────────────────────────
    if cfg.codex.enabled && codex_sessions.exists() {
        let rollouts = codex::walk_rollout_files(&codex_sessions).unwrap_or_default();
        for path in rollouts {
            // Skip files whose mtime is before the cutoff (no in-window lines).
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(mtime) = meta.modified() {
                    let mtime_ns = mtime
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos();
                    if mtime_ns < cutoff_ns { continue; }
                }
            }
            match process_codex_one(&path, cutoff_ns, &exporter).await {
                Ok((seen, emitted, old)) => {
                    total_codex_seen += seen;
                    total_codex_emitted += emitted;
                    total_codex_skipped_old += old;
                }
                Err(e) => {
                    total_codex_failed += 1;
                    warn!("backfill: codex {} failed: {e:#}", path.display());
                }
            }
        }
    }

    println!();
    println!("=== backfill complete ===");
    println!("[claude] scanned:    {total_seen} assistant lines");
    println!("[claude] emitted:    {total_emitted} spans (idempotent — server dedups by span_id)");
    println!("[claude] skipped:    {total_skipped_old} (older than cutoff)");
    if total_failed > 0 {
        println!("[claude] FAILED:     {total_failed} files (see warnings above)");
    }
    println!("[codex]  scanned:    {total_codex_seen} token_count events");
    println!("[codex]  emitted:    {total_codex_emitted} spans");
    println!("[codex]  skipped:    {total_codex_skipped_old} (older than cutoff)");
    if total_codex_failed > 0 {
        println!("[codex]  FAILED:     {total_codex_failed} files (see warnings above)");
    }
    println!();
    println!("Note: per-file offset watermarks are unchanged — `pulse-agent run`");
    println!("      resumes from where it was, with no gaps and no double-counting.");
    Ok(())
}

// ── Codex backfill: minimal replay of a rollout file ─────────────────────
//
// Mirrors codex::process_file but ignores the watermark and applies a
// timestamp cutoff. Reuses the same types via codex private state where
// possible — duplicating the JSON shapes here avoids leaking internal
// parsing details and keeps backfill standalone.

#[derive(Debug, Deserialize)]
struct CodexLine {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct CodexSessionMeta {
    cli_version: Option<String>,
    originator: Option<String>,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct CodexTurnContext {
    turn_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexEventMsg {
    #[serde(rename = "type")]
    kind: Option<String>,
    info: Option<CodexTokenInfo>,
    rate_limits: Option<CodexRateLimits>,
}

#[derive(Debug, Deserialize)]
struct CodexTokenInfo {
    last_token_usage: Option<CodexTokenUsage>,
    model_context_window: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CodexTokenUsage {
    input_tokens: Option<i64>,
    cached_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    reasoning_output_tokens: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
struct CodexRateLimits {
    plan_type: Option<String>,
}

async fn process_codex_one(
    path: &std::path::Path,
    cutoff_ns: u128,
    exporter: &OtlpExporter,
) -> Result<(usize, usize, usize)> {
    let f = OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let reader = BufReader::new(f);

    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| {
            if stem.len() >= 36 { Some(stem[stem.len() - 36..].to_string()) } else { None }
        });

    let mut cli_version: Option<String> = None;
    let mut originator: Option<String> = None;
    let mut session_cwd: Option<String> = None;
    let mut turn_id: Option<String> = None;
    let mut turn_cwd: Option<String> = None;
    let mut model: Option<String> = None;
    let mut approval: Option<String> = None;

    let mut seen = 0usize;
    let mut emitted = 0usize;
    let mut skipped_old = 0usize;

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }

        let parsed: CodexLine = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = match parsed.payload {
            Some(p) => p,
            None => continue,
        };

        match parsed.kind.as_deref().unwrap_or("") {
            "session_meta" => {
                if let Ok(m) = serde_json::from_value::<CodexSessionMeta>(payload) {
                    cli_version = m.cli_version;
                    originator = m.originator;
                    session_cwd = m.cwd;
                }
            }
            "turn_context" => {
                if let Ok(tc) = serde_json::from_value::<CodexTurnContext>(payload) {
                    turn_id = tc.turn_id;
                    turn_cwd = tc.cwd;
                    model = tc.model;
                    approval = tc.approval_policy;
                }
            }
            "event_msg" => {
                let ev: CodexEventMsg = match serde_json::from_value(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if ev.kind.as_deref() != Some("token_count") { continue; }
                let info = match ev.info { Some(i) => i, None => continue };
                let usage = match info.last_token_usage { Some(u) => u, None => continue };
                seen += 1;

                let ts_ns = parsed.timestamp.as_deref()
                    .and_then(parse_iso8601_to_ns)
                    .unwrap_or_else(now_ns);
                if ts_ns < cutoff_ns {
                    skipped_old += 1;
                    continue;
                }

                let cwd_for_git = turn_cwd.as_deref().or(session_cwd.as_deref());
                let (repo_name, git_branch) = match cwd_for_git {
                    Some(d) => git_info_from_dir(d),
                    None => (None, None),
                };
                let plan_type = ev.rate_limits.and_then(|r| r.plan_type);

                let span = SpanBuilder::new("gen_ai.request", ts_ns, ts_ns)
                    .attr_str("ashlr.source", "codex")
                    .attr_str("gen_ai.system", "openai")
                    .attr_str_opt("gen_ai.request.model", model.as_deref())
                    .attr_int_opt("gen_ai.usage.input_tokens", usage.input_tokens)
                    .attr_int_opt("gen_ai.usage.cache_read_tokens", usage.cached_input_tokens)
                    .attr_int_opt("gen_ai.usage.output_tokens", usage.output_tokens)
                    .attr_int_opt("gen_ai.usage.reasoning_tokens", usage.reasoning_output_tokens)
                    .attr_int_opt("gen_ai.openai.context_window", info.model_context_window)
                    .attr_str_opt("ashlr.codex.cli_version", cli_version.as_deref())
                    .attr_str_opt("ashlr.codex.originator", originator.as_deref())
                    .attr_str_opt("ashlr.codex.plan_type", plan_type.as_deref())
                    .attr_str_opt("ashlr.codex.approval_policy", approval.as_deref())
                    .attr_str_opt("ashlr.codex.session_id", session_id.as_deref())
                    .attr_str_opt("ashlr.codex.turn_id", turn_id.as_deref())
                    .attr_str_opt("claude.repo.name", repo_name.as_deref())
                    .attr_str_opt("claude.git.branch", git_branch.as_deref())
                    .build();

                if let Err(e) = exporter.export(&span).await {
                    warn!("backfill: codex export failed (will retry): {e:#}");
                    continue;
                }
                emitted += 1;
                if emitted % 50 == 0 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
            _ => {}
        }
    }
    Ok((seen, emitted, skipped_old))
}

async fn process_one(
    path: &std::path::Path,
    cutoff_ns: u128,
    exporter: &OtlpExporter,
) -> Result<(usize, usize, usize)> {
    let f = OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let reader = BufReader::new(f);

    let project_hash = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned());
    let session_id_from_filename = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned());

    let mut cwd: Option<String> = None;
    let mut seen = 0usize;
    let mut emitted = 0usize;
    let mut skipped_old = 0usize;

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }

        let parsed: Line = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if parsed.cwd.is_some() {
            cwd = parsed.cwd.clone();
        }
        let msg = match &parsed.message {
            Some(m) if m.role.as_deref() == Some("assistant") => m,
            _ => continue,
        };
        let usage = match &msg.usage {
            Some(u) => u,
            None => continue,
        };
        seen += 1;

        let ts_ns = parsed
            .timestamp
            .as_deref()
            .and_then(parse_iso8601_to_ns)
            .unwrap_or_else(now_ns);
        if ts_ns < cutoff_ns {
            skipped_old += 1;
            continue;
        }

        let (repo_name, branch_from_git) = match &cwd {
            Some(d) => git_info_from_dir(d),
            None => (None, None),
        };
        let git_branch = parsed.git_branch.clone().or(branch_from_git);
        let session_id = parsed.session_id.as_deref().or(session_id_from_filename.as_deref());

        let span = SpanBuilder::new("gen_ai.request", ts_ns, ts_ns)
            .attr_str("gen_ai.system", "anthropic")
            .attr_str_opt("gen_ai.request.model", msg.model.as_deref())
            .attr_int_opt("gen_ai.usage.input_tokens",  usage.input_tokens)
            .attr_int_opt("gen_ai.usage.output_tokens", usage.output_tokens)
            .attr_int_opt("gen_ai.usage.cache_read_tokens",  usage.cache_read_input_tokens)
            .attr_int_opt("gen_ai.usage.cache_write_tokens", usage.cache_creation_input_tokens)
            .attr_str_opt("claude.session.id", session_id)
            .attr_str_opt("claude.project.hash", project_hash.as_deref())
            .attr_str_opt("claude.repo.name", repo_name.as_deref())
            .attr_str_opt("claude.git.branch", git_branch.as_deref())
            .build();

        if let Err(e) = exporter.export(&span).await {
            warn!("backfill: export failed (will retry next run): {e:#}");
            // Don't fail the whole backfill — keep going; the user can
            // re-run later.
            continue;
        }
        emitted += 1;

        // Throttle so we don't slam the OTLP rate limit (60/min default).
        if emitted % 50 == 0 {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    Ok((seen, emitted, skipped_old))
}

fn walk_jsonl(projects_dir: &std::path::Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(projects_dir).context("reading projects dir")? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() { continue; }
        for inner in std::fs::read_dir(entry.path()).context("reading project subdir")? {
            let inner = inner?;
            let p = inner.path();
            if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(p);
            }
        }
    }
    Ok(out)
}

/// Parse a `--since` argument:
///   - "7d" → 7 days ago
///   - "24h" → 24 hours ago
///   - "30m" → 30 minutes ago
///   - "2026-04-20" → midnight UTC on that date
/// Returns the cutoff as unix nanoseconds.
pub fn parse_since(s: &str) -> Result<u128> {
    let s = s.trim();
    if s.is_empty() { bail!("--since cannot be empty") }

    // Absolute date YYYY-MM-DD?
    if s.len() == 10 && s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-') {
        let iso = format!("{}T00:00:00Z", s);
        return parse_iso8601_to_ns(&iso)
            .ok_or_else(|| anyhow!("could not parse date: {s}"));
    }

    // Relative duration: trailing unit char, leading integer.
    let (n_str, unit) = s.split_at(s.len().saturating_sub(1));
    let n: u128 = n_str.parse().with_context(|| format!("invalid number: {n_str:?}"))?;
    let secs: u128 = match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86400,
        "w" => n * 604800,
        _   => bail!("unknown --since unit {unit:?}; use s/m/h/d/w or YYYY-MM-DD"),
    };
    Ok(now_ns().saturating_sub(secs * 1_000_000_000))
}

#[cfg(test)]
mod tests {
    use super::parse_since;

    #[test]
    fn parses_durations() {
        assert!(parse_since("7d").is_ok());
        assert!(parse_since("24h").is_ok());
        assert!(parse_since("30m").is_ok());
        assert!(parse_since("60s").is_ok());
        assert!(parse_since("2w").is_ok());
    }

    #[test]
    fn parses_absolute_date() {
        let ns = parse_since("2026-04-20").unwrap();
        assert!(ns > 0);
        assert!(ns < 4_102_444_800_000_000_000);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_since("").is_err());
        assert!(parse_since("forever").is_err());
        assert!(parse_since("7x").is_err());
        assert!(parse_since("notanumber").is_err());
    }
}
