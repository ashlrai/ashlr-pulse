//! Tail ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and build codex OTLP spans.
//!
//! Each Codex turn produces one span carrying full per-turn token usage
//! (input / cached_input / output / reasoning_output) plus model name,
//! cli version, plan_type, rate-limit pressure, and tool-call counts.
//! No prompt text, completion text, reasoning text, or tool-call arguments
//! are ever read or transmitted — only structured metadata.
//!
//! Codex's per-session rollout file is append-only and emits a structured
//! event stream (`session_meta`, `turn_context`, `response_item`,
//! `event_msg`). We hold a small in-memory state machine across events:
//!   - `session_meta` (one per file) sets cli_version, originator,
//!     parent_thread_id (for subagent spawns).
//!   - `turn_context` resets the per-turn model + sandbox/approval policy
//!     and primes a fresh function-call counter.
//!   - `response_item:function_call` increments the counter and records
//!     the tool name (no arguments).
//!   - `event_msg:token_count` carries `last_token_usage` and
//!     `rate_limits.plan_type` — this fires the OTLP span emit, then we
//!     reset the per-turn function-call counter.
//!
//! File watching mirrors `claude.rs`: notify with a 5-second polling
//! fallback. Per-file watermarks live in the same `state.file_offsets`
//! table — Codex rollout paths and Claude session paths are globally
//! distinct so they cannot collide.

use std::collections::HashSet;
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

use crate::claude::{git_info_from_dir, parse_iso8601_to_ns};
use crate::otlp::OtlpExporter;
use crate::span::{now_ns, SpanBuilder};
use crate::state::StateDb;

// ── JSONL message shapes ───────────────────────────────────────────────────
//
// Codex's rollout JSONL is undocumented as a public API. We parse only the
// fields we need and ignore everything else. Any future Codex schema change
// that adds fields is forward-compatible; a rename of a field we depend on
// will silently stop emitting that attribute (intentional fallback over
// crashing the tailer).

#[derive(Debug, Deserialize)]
struct RolloutLine {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct SessionMeta {
    cli_version: Option<String>,
    originator: Option<String>,
    cwd: Option<String>,
    source: Option<SessionSource>,
}

#[derive(Debug, Deserialize)]
struct SessionSource {
    subagent: Option<SubagentSource>,
}

#[derive(Debug, Deserialize)]
struct SubagentSource {
    thread_spawn: Option<ThreadSpawn>,
}

#[derive(Debug, Deserialize)]
struct ThreadSpawn {
    parent_thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct TurnContext {
    turn_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<String>,
    sandbox_policy: Option<SandboxPolicy>,
    effort: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SandboxPolicy {
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// `event_msg` payload variants. We only care about `token_count`; other
/// kinds (agent_message, user_message, task_started, task_complete) are
/// observable but we don't emit spans for them today.
#[derive(Debug, Deserialize)]
struct EventMsg {
    #[serde(rename = "type")]
    kind: Option<String>,
    info: Option<TokenCountInfo>,
    rate_limits: Option<RateLimits>,
}

#[derive(Debug, Deserialize)]
struct TokenCountInfo {
    last_token_usage: Option<TokenUsage>,
    model_context_window: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TokenUsage {
    input_tokens: Option<i64>,
    cached_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    reasoning_output_tokens: Option<i64>,
}

#[derive(Debug, Deserialize, Default)]
struct RateLimits {
    plan_type: Option<String>,
    primary: Option<RateWindow>,
    secondary: Option<RateWindow>,
}

#[derive(Debug, Deserialize)]
struct RateWindow {
    used_percent: Option<f64>,
}

/// `response_item` payload — we only inspect `type` and `name`.
/// Specifically: payloads of type `message`, `reasoning`, and
/// `function_call_output` carry user-visible text we MUST NOT read.
/// `function_call` carries tool name + arguments; we read the name only.
#[derive(Debug, Deserialize)]
struct ResponseItem {
    #[serde(rename = "type")]
    kind: Option<String>,
    name: Option<String>,
}

// ── Main entry point ──────────────────────────────────────────────────────

/// Run the Codex source watcher indefinitely (cancels on `shutdown`).
///
/// `sessions_dir` is the parent of the date hierarchy
/// (`~/.codex/sessions`, which contains `YYYY/MM/DD/rollout-*.jsonl`).
/// Returns immediately if the directory does not exist — Codex may not
/// be installed on this machine.
pub async fn run(
    sessions_dir: PathBuf,
    exporter: Arc<OtlpExporter>,
    state: Arc<StateDb>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    if !sessions_dir.exists() {
        debug!("codex sessions dir {} does not exist; tailer idle",
            sessions_dir.display());
        // Still wait on shutdown so the join handle resolves cleanly.
        let _ = shutdown.changed().await;
        return;
    }

    let (fs_tx, mut fs_rx) = mpsc::channel::<()>(64);
    let poll_interval = Duration::from_secs(5);
    let fs_tx_clone = fs_tx.clone();

    let watcher_result: Result<RecommendedWatcher> = (|| {
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    let _ = fs_tx_clone.try_send(());
                }
            }
        })?;
        watcher.watch(&sessions_dir, RecursiveMode::Recursive)?;
        Ok(watcher)
    })();

    let _watcher = match watcher_result {
        Ok(w) => {
            debug!("using notify watcher for codex sessions dir");
            Some(w)
        }
        Err(e) => {
            warn!("notify watcher unavailable for codex ({e}), falling back to 5s polling");
            None
        }
    };

    // Polling fallback fires regardless of watcher state — sometimes
    // notify silently misses events on network/cmux directories.
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
                while fs_rx.try_recv().is_ok() {}
                if let Err(e) = scan_all(&sessions_dir, &exporter, &state).await {
                    warn!("codex scan error: {e:#}");
                }
            }
            _ = shutdown.changed() => {
                debug!("codex watcher shutting down");
                return;
            }
        }
    }
}

async fn scan_all(
    sessions_dir: &Path,
    exporter: &OtlpExporter,
    state: &StateDb,
) -> Result<()> {
    for path in walk_rollout_files(sessions_dir)? {
        if let Err(e) = process_file(&path, exporter, state).await {
            warn!("codex: error processing {}: {e:#}", path.display());
        }
    }
    Ok(())
}

/// Walk `sessions_dir/YYYY/MM/DD/rollout-*.jsonl` and return all matching
/// paths. We don't enforce the date format on the directory names — any
/// recursive descendant matching `rollout-*.jsonl` is included so a
/// hypothetical Codex schema change to flatten the hierarchy still works.
pub fn walk_rollout_files(sessions_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    walk_recursive(sessions_dir, &mut out)?;
    out.sort(); // deterministic for tests
    Ok(out)
}

fn walk_recursive(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return Ok(()), // unreadable subdir — skip silently
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_recursive(&path, out)?;
        } else if ft.is_file() && is_rollout_file(&path) {
            out.push(path);
        }
    }
    Ok(())
}

fn is_rollout_file(p: &Path) -> bool {
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

/// In-memory state held between events in a single rollout file. Reset
/// per turn for the function-call counter; carried across turns for
/// session_meta + latest turn_context.
#[derive(Debug, Default)]
struct FileState {
    cli_version: Option<String>,
    originator: Option<String>,
    parent_thread_id: Option<String>,
    session_cwd: Option<String>,
    turn_id: Option<String>,
    turn_cwd: Option<String>,
    model: Option<String>,
    approval_policy: Option<String>,
    sandbox_policy: Option<String>,
    effort: Option<String>,
    turn_start_ns: Option<u128>,
    function_call_count: i64,
    function_call_names: HashSet<String>,
}

impl FileState {
    fn reset_turn(&mut self) {
        self.turn_id = None;
        self.turn_start_ns = None;
        self.function_call_count = 0;
        self.function_call_names.clear();
        // model/sandbox/approval/cwd are kept across turns until the next
        // turn_context arrives (Codex resends them every turn anyway).
    }
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
        return Ok(());
    }

    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(&file);

    let mut byte_cursor = offset;
    let mut last_good_offset = offset;

    // The session id is the filename's UUID suffix:
    // rollout-<TS>-<UUID>.jsonl
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| {
            // Parse last UUID segment after the last 'T'-stamped timestamp.
            // UUIDs are 8-4-4-4-12 = 36 chars including hyphens; take the
            // last 36 chars of the stem. Falls back to None if shorter.
            if stem.len() >= 36 { Some(stem[stem.len() - 36..].to_string()) } else { None }
        });

    let mut s = FileState::default();
    let mut spans_emitted = 0usize;

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        let line_end = byte_cursor + n as u64;
        byte_cursor = line_end;

        let trimmed = line.trim();
        if trimmed.is_empty() {
            last_good_offset = line_end;
            continue;
        }

        let parsed: RolloutLine = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                last_good_offset = line_end;
                continue;
            }
        };

        let kind = parsed.kind.as_deref().unwrap_or("");
        let payload = match parsed.payload {
            Some(p) => p,
            None => {
                last_good_offset = line_end;
                continue;
            }
        };

        match kind {
            "session_meta" => {
                if let Ok(meta) = serde_json::from_value::<SessionMeta>(payload) {
                    s.cli_version = meta.cli_version;
                    s.originator = meta.originator;
                    s.session_cwd = meta.cwd;
                    s.parent_thread_id = meta
                        .source
                        .and_then(|src| src.subagent)
                        .and_then(|sa| sa.thread_spawn)
                        .and_then(|sp| sp.parent_thread_id);
                }
                last_good_offset = line_end;
            }

            "turn_context" => {
                if let Ok(tc) = serde_json::from_value::<TurnContext>(payload) {
                    s.reset_turn();
                    s.turn_id = tc.turn_id;
                    s.turn_cwd = tc.cwd;
                    s.model = tc.model;
                    s.approval_policy = tc.approval_policy;
                    s.sandbox_policy = tc.sandbox_policy.and_then(|p| p.kind);
                    s.effort = tc.effort;
                    // Mark the turn start time from the line timestamp,
                    // for duration_ms calculation when token_count fires.
                    s.turn_start_ns = parsed
                        .timestamp
                        .as_deref()
                        .and_then(parse_iso8601_to_ns);
                }
                last_good_offset = line_end;
            }

            "response_item" => {
                // Only inspect `type` + `name` — never read
                // `arguments`, `content`, or output bodies. The
                // ResponseItem deserializer is intentionally narrow
                // and drops anything else from the payload.
                if let Ok(item) = serde_json::from_value::<ResponseItem>(payload) {
                    if item.kind.as_deref() == Some("function_call") {
                        s.function_call_count += 1;
                        if let Some(name) = item.name {
                            s.function_call_names.insert(name);
                        }
                    }
                }
                last_good_offset = line_end;
            }

            "event_msg" => {
                let ev: EventMsg = match serde_json::from_value(payload) {
                    Ok(v) => v,
                    Err(_) => {
                        last_good_offset = line_end;
                        continue;
                    }
                };
                if ev.kind.as_deref() != Some("token_count") {
                    last_good_offset = line_end;
                    continue;
                }
                let info = match ev.info {
                    Some(i) => i,
                    None => {
                        // Codex emits a header token_count on session
                        // start with info=null. Skip it but advance the
                        // watermark (we'll never need to re-read it).
                        last_good_offset = line_end;
                        continue;
                    }
                };
                let usage = match info.last_token_usage {
                    Some(u) => u,
                    None => {
                        last_good_offset = line_end;
                        continue;
                    }
                };

                let ts_ns = parsed
                    .timestamp
                    .as_deref()
                    .and_then(parse_iso8601_to_ns)
                    .unwrap_or_else(now_ns);

                // Use turn_start (from the preceding turn_context) as the
                // span start so duration_ms is meaningful. If no
                // turn_context was seen yet (mid-file resume after cursor
                // restart), fall back to a zero-duration point span.
                let start_ns = s.turn_start_ns.unwrap_or(ts_ns);

                // Repo derivation prefers turn cwd, falls back to session
                // cwd. git_info_from_dir is shared with claude.rs so the
                // remote-URL parsing stays consistent across sources.
                let cwd_for_git = s.turn_cwd.as_deref().or(s.session_cwd.as_deref());
                let (repo_name, git_branch) = match cwd_for_git {
                    Some(d) => git_info_from_dir(d),
                    None => (None, None),
                };

                let plan_type = ev
                    .rate_limits
                    .as_ref()
                    .and_then(|r| r.plan_type.clone());
                let primary_pct = ev
                    .rate_limits
                    .as_ref()
                    .and_then(|r| r.primary.as_ref())
                    .and_then(|w| w.used_percent);
                let secondary_pct = ev
                    .rate_limits
                    .as_ref()
                    .and_then(|r| r.secondary.as_ref())
                    .and_then(|w| w.used_percent);

                // Tool-call types: deterministic ordering for the
                // comma-joined attribute. HashSet → Vec → sort → join.
                let mut tool_types: Vec<String> =
                    s.function_call_names.iter().cloned().collect();
                tool_types.sort();
                let tool_types_csv = if tool_types.is_empty() {
                    None
                } else {
                    Some(tool_types.join(","))
                };

                let mut builder = SpanBuilder::new("gen_ai.request", start_ns, ts_ns)
                    .attr_str("ashlr.source", "codex")
                    .attr_str("gen_ai.system", "openai")
                    .attr_str_opt("gen_ai.request.model", s.model.as_deref())
                    .attr_int_opt("gen_ai.usage.input_tokens", usage.input_tokens)
                    .attr_int_opt("gen_ai.usage.cache_read_tokens", usage.cached_input_tokens)
                    .attr_int_opt("gen_ai.usage.output_tokens", usage.output_tokens)
                    .attr_int_opt("gen_ai.usage.reasoning_tokens", usage.reasoning_output_tokens)
                    .attr_int_opt("gen_ai.openai.context_window", info.model_context_window)
                    .attr_str_opt("ashlr.codex.cli_version", s.cli_version.as_deref())
                    .attr_str_opt("ashlr.codex.originator", s.originator.as_deref())
                    .attr_str_opt("ashlr.codex.parent_thread_id", s.parent_thread_id.as_deref())
                    .attr_str_opt("ashlr.codex.plan_type", plan_type.as_deref())
                    .attr_str_opt("ashlr.codex.sandbox_policy", s.sandbox_policy.as_deref())
                    .attr_str_opt("ashlr.codex.approval_policy", s.approval_policy.as_deref())
                    .attr_str_opt("ashlr.codex.effort", s.effort.as_deref())
                    .attr_str_opt("ashlr.codex.session_id", session_id.as_deref())
                    .attr_str_opt("ashlr.codex.turn_id", s.turn_id.as_deref())
                    // Reuse the server's claude.tool.* namespace for
                    // tool-call counts so existing dashboard plumbing in
                    // otel-genai.ts / dashboard-data.ts treats Codex
                    // tool-call telemetry the same as Claude's.
                    .attr_int("claude.tool.calls_count", s.function_call_count)
                    .attr_str_opt("claude.tool.calls_types", tool_types_csv)
                    .attr_str_opt("claude.repo.name", repo_name.as_deref())
                    .attr_str_opt("claude.git.branch", git_branch.as_deref());

                if let Some(p) = primary_pct {
                    builder = builder.attr_int(
                        "ashlr.codex.rate_limit_primary_pct",
                        p as i64,
                    );
                }
                if let Some(p) = secondary_pct {
                    builder = builder.attr_int(
                        "ashlr.codex.rate_limit_secondary_pct",
                        p as i64,
                    );
                }

                let span = builder.build();

                if let Err(e) = exporter.export(&span).await {
                    warn!("codex: failed to export span: {e:#}");
                    // Don't advance watermark past the failed line — break
                    // so the next scan re-attempts at last_good_offset.
                    break;
                }
                last_good_offset = line_end;
                spans_emitted += 1;
                // Reset per-turn counter for the next turn.
                s.reset_turn();
            }

            _ => {
                // Unknown event kind — advance the watermark; future Codex
                // versions adding new event types should not stall us.
                last_good_offset = line_end;
            }
        }
    }

    if last_good_offset > offset {
        state.set_file_offset(&path_str, last_good_offset)?;
        if spans_emitted > 0 {
            debug!(path = %path.display(), spans = spans_emitted, "exported codex spans");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_rollout_file_recognizes_real_names() {
        assert!(is_rollout_file(Path::new(
            "/x/rollout-2026-05-08T19-06-18-019e09d7-7f12-7fc0-ac18-5e1572aa7287.jsonl"
        )));
        assert!(!is_rollout_file(Path::new("/x/history.jsonl")));
        assert!(!is_rollout_file(Path::new("/x/rollout-thing.txt")));
        assert!(!is_rollout_file(Path::new("/x/notrollout.jsonl")));
    }

    #[test]
    fn walk_returns_empty_for_missing_dir() {
        let nowhere = Path::new("/tmp/does/not/exist/here-please");
        let r = walk_rollout_files(nowhere).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn walk_finds_nested_files() {
        let tmp = std::env::temp_dir().join(format!(
            "pulse-codex-walk-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let nested = tmp.join("2026/05/08");
        std::fs::create_dir_all(&nested).unwrap();
        let f1 = nested.join("rollout-2026-05-08T00-00-00-aaa.jsonl");
        let f2 = nested.join("rollout-2026-05-08T01-00-00-bbb.jsonl");
        let f3 = nested.join("history.jsonl"); // should be ignored
        std::fs::write(&f1, "").unwrap();
        std::fs::write(&f2, "").unwrap();
        std::fs::write(&f3, "").unwrap();

        let mut got = walk_rollout_files(&tmp).unwrap();
        got.sort();
        assert_eq!(got, vec![f1, f2]);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn file_state_reset_turn_clears_per_turn_fields() {
        let mut s = FileState::default();
        s.cli_version = Some("0.129.0".to_string());
        s.model = Some("gpt-5.5".to_string());
        s.turn_id = Some("turn-123".to_string());
        s.function_call_count = 5;
        s.function_call_names.insert("exec_command".to_string());
        s.turn_start_ns = Some(1_000_000_000);

        s.reset_turn();

        // session-scoped fields preserved
        assert_eq!(s.cli_version.as_deref(), Some("0.129.0"));
        // model is per-turn but Codex resets it via the next turn_context;
        // we keep it as a fallback so a token_count without a preceding
        // turn_context (mid-file resume) still has model info.
        assert_eq!(s.model.as_deref(), Some("gpt-5.5"));
        // per-turn fields cleared
        assert_eq!(s.turn_id, None);
        assert_eq!(s.function_call_count, 0);
        assert!(s.function_call_names.is_empty());
        assert_eq!(s.turn_start_ns, None);
    }

    #[test]
    fn parses_token_count_payload() {
        let raw = r#"{"type":"token_count","info":{"last_token_usage":{"input_tokens":113007,"cached_input_tokens":111488,"output_tokens":287,"reasoning_output_tokens":22,"total_tokens":113294},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":37.0,"window_minutes":300},"secondary":{"used_percent":27.0,"window_minutes":10080},"plan_type":"prolite"}}"#;
        let ev: EventMsg = serde_json::from_str(raw).unwrap();
        assert_eq!(ev.kind.as_deref(), Some("token_count"));
        let info = ev.info.unwrap();
        let u = info.last_token_usage.unwrap();
        assert_eq!(u.input_tokens, Some(113007));
        assert_eq!(u.cached_input_tokens, Some(111488));
        assert_eq!(u.output_tokens, Some(287));
        assert_eq!(u.reasoning_output_tokens, Some(22));
        assert_eq!(info.model_context_window, Some(258400));
        let rl = ev.rate_limits.unwrap();
        assert_eq!(rl.plan_type.as_deref(), Some("prolite"));
        assert_eq!(rl.primary.unwrap().used_percent, Some(37.0));
        assert_eq!(rl.secondary.unwrap().used_percent, Some(27.0));
    }

    #[test]
    fn parses_session_meta_with_subagent_parent() {
        let raw = r#"{"id":"019e09d1-7b89-7a31-a45b-ade3432e48fd","timestamp":"2026-05-08T22:59:44Z","cwd":"/Users/x/proj","originator":"codex-tui","cli_version":"0.129.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019e09ae-f6cd-7f80-9506-63427442b994","depth":1}}}}"#;
        let m: SessionMeta = serde_json::from_str(raw).unwrap();
        assert_eq!(m.cli_version.as_deref(), Some("0.129.0"));
        assert_eq!(m.originator.as_deref(), Some("codex-tui"));
        assert_eq!(m.cwd.as_deref(), Some("/Users/x/proj"));
        let parent = m
            .source
            .and_then(|s| s.subagent)
            .and_then(|sa| sa.thread_spawn)
            .and_then(|sp| sp.parent_thread_id);
        assert_eq!(parent.as_deref(), Some("019e09ae-f6cd-7f80-9506-63427442b994"));
    }

    #[test]
    fn parses_session_meta_without_subagent() {
        let raw = r#"{"cli_version":"0.129.0","originator":"codex-exec","cwd":"/tmp","id":"abc"}"#;
        let m: SessionMeta = serde_json::from_str(raw).unwrap();
        assert_eq!(m.originator.as_deref(), Some("codex-exec"));
        assert!(m.source.is_none());
    }

    #[test]
    fn parses_turn_context() {
        let raw = r#"{"turn_id":"019e09d1-7b8b-7933-acea-4fa293a3e2a5","cwd":"/Users/x/proj","current_date":"2026-05-08","timezone":"America/New_York","approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},"permission_profile":{"type":"disabled"},"model":"gpt-5.5","effort":"medium"}"#;
        let tc: TurnContext = serde_json::from_str(raw).unwrap();
        assert_eq!(tc.turn_id.as_deref(), Some("019e09d1-7b8b-7933-acea-4fa293a3e2a5"));
        assert_eq!(tc.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(tc.approval_policy.as_deref(), Some("never"));
        assert_eq!(tc.sandbox_policy.unwrap().kind.as_deref(), Some("danger-full-access"));
        assert_eq!(tc.effort.as_deref(), Some("medium"));
    }

    #[test]
    fn response_item_does_not_deserialize_arguments_or_content() {
        // Privacy floor canary: even though the JSON contains arguments
        // and content fields, the ResponseItem struct must NOT carry
        // them out — only kind + name are extracted.
        let raw = r#"{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"rm -rf /\"}"}"#;
        let item: ResponseItem = serde_json::from_str(raw).unwrap();
        assert_eq!(item.kind.as_deref(), Some("function_call"));
        assert_eq!(item.name.as_deref(), Some("exec_command"));
        // The struct only has two fields — there's nothing to assert
        // about `arguments` because it does not exist as a Rust field.
        // This compile-time guarantee is the test.
    }

    #[test]
    fn skips_token_count_with_null_info() {
        // Codex's first token_count event of a session has info=null
        // (a session-start header). We must not panic or emit a span
        // for it; the sentinel info=Option<None> means the EventMsg
        // deserializes but the early-return path skips emission.
        let raw = r#"{"type":"token_count","info":null,"rate_limits":{"plan_type":"pro"}}"#;
        let ev: EventMsg = serde_json::from_str(raw).unwrap();
        assert!(ev.info.is_none());
        assert_eq!(ev.rate_limits.unwrap().plan_type.as_deref(), Some("pro"));
    }
}
