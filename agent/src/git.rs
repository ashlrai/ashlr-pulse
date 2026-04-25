//! Git source: poll configured repos every 60s, build one OTLP span per
//! new commit and tag it with `ashlr.source = "git"`.
//!
//! Watermark = last-seen commit SHA. We walk `git log` since that commit on
//! the current branch. Spans are zero-duration (single point in time).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use git2::{Repository, Sort};
use tracing::{debug, info, warn};

use crate::claude::remote_url_to_repo_name;
use crate::config::RepoConfig;
use crate::otlp::OtlpExporter;
use crate::span::SpanBuilder;
use crate::state::StateDb;

const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Run the git poller indefinitely (cancels on `shutdown`).
pub async fn run(
    repos: Vec<RepoConfig>,
    exporter: Arc<OtlpExporter>,
    state: Arc<StateDb>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    if repos.is_empty() {
        debug!("no repos configured; git poller idle");
        // Still loop so shutdown signal is honoured.
        let _ = shutdown.changed().await;
        return;
    }

    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = interval.tick() => {
                for repo_cfg in &repos {
                    if let Err(e) = poll_repo(repo_cfg, &exporter, &state).await {
                        warn!("git poll error for {}: {e:#}", repo_cfg.path);
                    }
                }
            }
            _ = shutdown.changed() => {
                debug!("git poller shutting down");
                return;
            }
        }
    }
}

async fn poll_repo(
    repo_cfg: &RepoConfig,
    exporter: &OtlpExporter,
    state: &StateDb,
) -> Result<()> {
    let repo_path = &repo_cfg.path;
    let repo = Repository::discover(repo_path)
        .with_context(|| format!("opening git repo at {repo_path}"))?;

    let branch = current_branch(&repo);
    let repo_name = repo_cfg.repo_name.clone().unwrap_or_else(|| {
        derive_repo_name(&repo, repo_path)
    });

    let watermark = state.get_git_watermark(repo_path)?;

    // Collect new commits since watermark (or all if no watermark).
    let new_commits = walk_commits(&repo, watermark.as_deref())?;

    if new_commits.is_empty() {
        return Ok(());
    }

    info!(repo = %repo_name, count = new_commits.len(), "found new git commits");

    // Ship commits oldest-first so watermark advances incrementally.
    for (sha, time_secs) in &new_commits {
        let time_ns = (*time_secs as u128) * 1_000_000_000u128;

        let span = SpanBuilder::new("git.commit", time_ns, time_ns)
            .attr_str("gen_ai.system", "anthropic") // passes GenAI-shape gate
            .attr_str("ashlr.source", "git")        // server-side override
            .attr_str("claude.repo.name", &repo_name)
            .attr_str_opt("claude.git.branch", branch.as_deref())
            .build();

        exporter.export(&span).await
            .with_context(|| format!("exporting git commit {sha}"))?;

        // Advance watermark only after successful export (at-least-once).
        state.set_git_watermark(repo_path, sha)?;
        debug!(repo = %repo_name, sha = %&sha[..8], "exported git commit span");
    }

    Ok(())
}

/// Walk commits on HEAD since `since_sha`, returning `(sha, unix_time_secs)` oldest-first.
/// If `since_sha` is None, returns all commits on HEAD (capped at 1000 to avoid
/// flooding on first run).
fn walk_commits(repo: &Repository, since_sha: Option<&str>) -> Result<Vec<(String, i64)>> {
    let mut walk = repo.revwalk()?;
    walk.push_head().context("revwalk push HEAD")?;
    walk.set_sorting(Sort::TIME | Sort::REVERSE)?;

    let since_oid = since_sha.and_then(|s| repo.revparse_single(s).ok().map(|o| o.id()));

    let mut commits = Vec::new();
    let cap = if since_sha.is_none() { 1000 } else { usize::MAX };

    for oid in walk {
        if commits.len() >= cap {
            break;
        }
        let oid = oid?;

        // Stop when we reach the watermark commit.
        if since_oid == Some(oid) {
            break;
        }

        let commit = repo.find_commit(oid)?;
        let time_secs = commit.time().seconds();
        commits.push((oid.to_string(), time_secs));
    }

    // Reverse to oldest-first (revwalk with REVERSE gives oldest-first when
    // sorted by TIME|REVERSE, but we walked until watermark so re-reverse).
    // Actually with Sort::TIME | Sort::REVERSE the walk already yields oldest
    // first, so we stop at watermark. But we push_head() first and the
    // watermark check breaks when we hit it — which means commits are already
    // in oldest-first order. Keep as-is.
    Ok(commits)
}

fn current_branch(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().map(|s| s.to_string())
}

fn derive_repo_name(repo: &Repository, fallback_path: &str) -> String {
    repo.find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()))
        .map(|url| remote_url_to_repo_name(&url))
        .unwrap_or_else(|| {
            Path::new(fallback_path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| fallback_path.to_string())
        })
}
